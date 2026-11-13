# Bloma 应用图标

2026-11-14 用户指定 `bloma-icon-crayon-blush.png` 作为应用图标。`icon.png` 保存原图副本，尺寸为 1254×1254，SHA-256 为 `6996611E4DEBB334C7DE54618B3E4E82BDFCB1B8E62DFD1FF943C5739C60318A`。

主窗口由 `main/platform/shell/app-icon.ts` 选择 Windows ICO 或其他平台 PNG。页面 favicon 使用 `renderer/index.html` 中的资源引用，托盘使用 `resources/tray/icon32.png`，并提供 16 像素版本。

运行 `scripts/prepare-brand-icon.ps1 -Source <原图路径>` 可生成配套资源。ICO 包含 16、24、32、48、64、128、256 七种尺寸，脚本等比例缩放原图并保留构图。

正常重新启动 Bloma 后加载窗口和托盘图标。未来制作安装包时，还需将资源纳入打包配置，并设置可执行文件和安装快捷方式图标。
