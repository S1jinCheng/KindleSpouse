# KindleSpouse 的 KOReader 主页

适配目标是第一代 Kindle Scribe 与 KOReader v2026.07.1。连接设备已确认 Kindle 系统为 5.20.1、KOReader 为 v2026.07.1。[KOReader 内置 Notebook 实验](../experiments/notebook/README.md)已通过电脑模拟，并在用户重新明确要求后安装为独立预览版；正式安装包仍未默认启用该实验。

Library 使用 KOReader 自带的封面缓存和封面网格，汇总书籍目录及子目录中的图书。优先采用已有的书籍主页目录，默认使用 `/mnt/us/documents`。隐藏目录、`.notebooks`、`.sdr` 和符号链接不进入书架。没有封面的图书继续使用 KOReader 的文字封面。点击封面打开原书，长按保留原生文件操作。

底部只有 Library 和 Notebook。顶部沿用 KOReader 的标题栏、菜单手势、设置及加号菜单。横竖屏重新计算书架高度，为底部导航预留独立空间。

书架增加了独立的两行工具栏：书名／作者／文件名搜索，全部、未读、在读、已读、收藏和书集入口；筛选菜单可按格式、作者和来源文件夹组合筛选。支持最近阅读、最近添加、书名、作者、阅读进度排序，以及封面网格／带封面的详情列表切换。筛选、排序和视图设置会保存。来源指设备上的一级书籍文件夹，不代表桌面端的网盘或书源账号。首次整理书库会读取图书元数据，并缓存到 KOReader 本地设置目录。

Notebook 指向 Scribe 原生手写笔记功能。标签页说明如何进入，并提供正常保存、退出 KOReader 的按钮。退出后需要点击 Kindle 原生界面的“笔记本”。当前没有实现从 KOReader 直接进入指定手写笔记本，也没有在 KOReader 内编辑 Amazon 的原生笔记格式。

## 字体

安装包包含十款静态字体，重新启动 KOReader 后可在书内字体菜单选择：

- 宋体：Noto Serif CJK SC，适合长篇正文。
- 黑体：Noto Sans CJK SC，适合希望笔画更均匀的阅读场景。
- 楷体风格：LXGW WenKai，霞鹜文楷。
- 仿宋：FandolFang，适合引文、诗文及仿宋风格正文。
- Fandol 宋体、Fandol 黑体、Fandol 楷体。
- 霞鹜文楷 GB、霞鹜新致宋、霞鹜臻楷 GB。

这些字体代表出版常见的宋、黑、楷、仿宋风格。Fandol 字库较小，涉及生僻字、繁体及多语言内容时优先选 Noto，并保留 KOReader 原来的后备字体配置。原有图书的字体选择不会被强制改写。字体保留原名与原始许可证，全部以固定 SHA-256 校验后打包。霞鹜新致宋使用 IPA Font License 1.0，其余新增字体分别遵循原始 OFL 或 Fandol 的 GPL 字体嵌入例外许可。

## 构建与安装

运行 `npm run package:device` 得到 `artifacts/KindleSpouse-Device-Update.zip` 和校验文件。完整包包含现有同步、休眠封面插件及新增主页和字体，不含个人配对凭据。

先退出 KOReader，再把压缩包里的 `koreader`、`kindlespouse` 文件夹合并复制到 Kindle USB 根目录，保留现有的 `config.json`、`rclone.conf` 和暂停标记。也可在连接设备后使用已有的 `scripts/install-device-update.ps1`，它会备份将被覆盖的文件并回读验证。

重新启动 KOReader 后显示新主页。在顶部菜单中关闭 KindleSpouse → Use KindleSpouse home，可恢复原文件浏览器和此前的启动、显示模式。字体可继续保留，也可退出 KOReader 后移除 `koreader/fonts/kindlespouse` 文件夹。

运行 `npm run test:koreader-home` 在项目自带的真实 KOReader 运行时中检查封面、子目录、标签切换、横竖屏、原生退出和恢复开关，并在 `artifacts` 生成截图。此检查不等同于第一代 Scribe 上的触控、手写及刷新速度验收。
