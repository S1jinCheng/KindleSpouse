# KindleSpouse 图标

采用已确认的 C 方案：暖白底色、深墨色阅读器和环抱设备的陶土色书页。应用、窗口、网页图标和仓库首页使用同一份资源。

`public/brand/icon.png` 是通过内置 image_gen 工具从 C 方案提取的透明背景图标。`build/icon.ico` 包含 16、24、32、48、64、128、256 像素帧，使用 `npm run icons:build` 从 PNG 导出；`npm run package` 会先重新导出图标。

最终清理提示词：

> Precise cleanup edit of the provided approved KindleSpouse app icon. Keep the central device, terracotta wrapping book page, ivory rounded square, composition and colors exactly unchanged. Fix only the outer silhouette and transparency: the ivory tile must have a perfectly smooth clean rounded-square outline. Remove absolutely every stray white fleck, scratch, speckle, thin line, fringe and noise outside that rounded square. All pixels outside the clean tile silhouette should be fully transparent. Leave an even 4 percent transparent margin on all four sides. Clean vector-like edges, no frayed or distressed texture anywhere near the edge. Do not add, redesign, rearrange or recolor the emblem. No text. One production-ready icon only.
