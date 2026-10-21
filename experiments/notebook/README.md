# KOReader 内置 Notebook 电脑实验

本次新版仅在电脑运行并提供预览。用户看过布局、完成修改后，再安排 USB 安装；原生编辑器跳转测试仍暂停。

Notebook 标签页在同一个 KOReader 进程中显示笔记封面，采用用户提供的 Kindle 原生界面布局，保留顶部设置和 Library／Notebooks 两个底部标签。搜索集中在顶部，笔记页提供新建笔记、文件夹与排序。点击封面进入手写编辑器，保存返回后继续显示笔记封面；不经过 Kindle 首页或 KUAL。

手写引擎采用 [pierspad/notebook.koplugin](https://github.com/pierspad/notebook.koplugin)，MIT，固定提交和完整源代码压缩包 SHA-256 记录在 `engine.json`。引擎及其许可证保存在忽略跟踪的本机测试目录；没有修改或重发上游源代码。实验适配器和 KOReader 主页共同使用 AGPL-3.0，见 `LICENSE`。

## 当前验证

个人页同步 KindleSpouse 的今日阅读、累计阅读、读过的书和阅读天数，并显示最近 52 周的灰度阅读日历；分钟数分为 0、少于 15、15 至 30、30 至 60、60 以上五档，点击方块查看日期与时长。统计取自相同的 KOReader 阅读记录，按上海日期汇总；同步载荷仅包含汇总数与最近 366 天的日期／秒数，不含书名或文件路径。局域网与网盘均已验证统计落盘，新增阅读会更新资料版本并拒绝旧回执。旧资料缺少统计时提示待同步，真实空记录显示零；跨天未同步时今日时长显示待同步，累计数据仍标明记录截止日期。新导入的网盘阅读记录在同一轮电脑同步结束前重新发布，供设备下次接收。原生 Kindle 阅读器时长暂未接入。

已在真实 KOReader v2026.07.1 的 SDL 模拟器中验证封面点按、笔记搜索、触摸输入画笔、整笔橡皮、撤销／重做按钮、多页切换、文件夹进入／返回、保存重开和两个底部标签切换，并检查竖屏、横屏截图。所有截图使用合成笔记和合成个人资料。电脑验收包括凸出底栏部分的点击、过滤后的继续阅读、个人页同步中／暂停／失败／未配对状态，以及真实 TLS 局域网和网盘回退的资料传输。

新版采用原生风格状态栏、圆角搜索框、左侧筛选和右侧排序按钮，移除大标题、Home、More、购物车及家庭入口。底部选中标签用下划线标识，中间浮起上次阅读的图书封面；从阅读历史选择实际存在的最近图书，点击封面调用 KOReader 正常阅读入口，当前书库筛选不影响继续阅读。左上角头像打开个人资料页，显示 KindleSpouse 昵称、头像、网盘列表、资料更新时间和设备同步进度，并连接同步资料、立即同步、暂停和继续操作。网盘名称与连接状态来自最近一次资料同步，不代表实时探测云端连通性。网盘字段需要更新后的 KindleSpouse 桌面端和同步组件；旧资料没有这些字段时会明确提示尚未同步。书库默认最近阅读排序和列表显示，保留网格切换、纵向滚动、小封面、书名作者、阅读进度、未读标记及逐书操作。字体沿用 KindleSpouse 的分工：标题、书名和统计数值采用 Noto Serif SC 宋体，菜单、说明采用 Noto Sans SC 黑体；在 KOReader 使用随包已有的 Noto Serif CJK SC／Noto Sans CJK SC 静态版本，不依赖 Amazon Ember。标题及数值使用常规字重。电脑预览加载与安装包相同的静态字库。测试覆盖滑动距离、不误触封面、滑动后长按选择、标签切换后的滚动位置恢复，以及 1000 项书架的可见区域渲染。搜索、阅读状态、收藏、书集、作者／格式／目录筛选、排序和列表切换继续通过验收，十种中文字体通过常用汉字字形检查。启动枚举只读取已有元数据，不再为整个书库同步打开文档；这项改动不能单独证明此前设备停留在 Opening 的具体原因。

另用电脑端已有的一个私人 Scribe 笔记备份进行离线解码：5 页、1547 条原始笔画。向量导入后可以删除旧笔画、撤销，再添加新笔画并保存重开；原始 NBK 文件 SHA-256 保持不变。私人文件和其截图不发布。

**这仍未满足“直接编辑原来的 Amazon 原生笔记文件”的完整要求。** 编辑结果保存在独立 `.scribe` 副本中，尚不能写回 Amazon NBK 并交由原生编辑器继续编辑。导入不是 PDF 叠写，旧笔画确实作为独立对象载入，但笔刷、颜色、透明度等仍存在近似映射；原生纸张模板、云端标识和同步语义没有恢复。模拟器也不能证明真机笔延迟、压感和手掌抑制效果。

## 在 KindleSpouse 主项目复现

准备项目现有 KOReader 运行时后，运行 `npm run test:notebook-embedded`。测试自行生成书籍与笔记样本，结果位于 `artifacts/notebook-embedded-*.png`，运行数据仅位于 `.test-data`。

已有解码器通过 `scripts/install-notebook-tool.mjs` 准备。`decode.mjs` 是独立的 GPL-3.0-only 离线入口，使用已有 `neo_scribe_to_pdf` 解码模块，只读取本地 NBK 副本并写入一个全新的向量 JSON 文件，不能写回 NBK。其许可证见 `DECODE-LICENSE`。启用私人备份测试需要本地提供 `.test-data/notebook-offline/latest-path.txt`；公开自动测试不会读取用户目录。

## 在 KOReader fork 或 Linux 复现

先通过 `python3 kindlespouse/build.py` 准备 fork 的校验字库缓存，再运行 `python3 experiments/notebook/simulate.py --runtime /absolute/path/to/koreader`；也可用 `--fonts /absolute/path/to/reader-fonts` 指定包含 Noto 宋体和黑体的已有静态字库目录。脚本只下载并校验固定版本手写引擎，在独立测试目录中运行 KOReader，并生成合成数据截图。也可通过 `--engine /absolute/path/to/notebook/lua` 使用已有引擎。

KOReader fork 中实验不会进入正式安装包，不会修改启动器。NBK 离线解码工具仍位于 KindleSpouse 主项目，fork 的公开自动验证仅使用合成向量样本。

## 用户授权的设备预览

先退出 KOReader 并连接 USB。依次运行 `scripts/prepare-notebook-preview.ps1`、`node scripts/build-notebook-preview.mjs`、`node scripts/verify-notebook-preview.mjs`，最后运行 `scripts/install-notebook-preview.ps1`。这些步骤会读取设备上的独立原生笔记，生成单独的 `.scribe` 副本，并用与设备安装相同的补丁、插件和引擎文件在模拟器中检查启动、列表、书写、保存重开与返回主页。

安装器要求 KOReader v2026.07.1，备份将被覆盖的组件及阅读设置，逐文件回读校验，最后才安装激活补丁。副本放在 `koreader/notebook/Scribe 可编辑副本`，首次进入 Notebook 会显示该目录。已有同名副本目录时停止，防止覆盖用户对副本的修改。原生 `.notebooks` 目录没有写入目标，安装结束后重新读取原生笔记并核对哈希；配对配置及已有阅读设置不由安装器改写。

上一版用户授权的安装准备了 28 本副本、158 页、44382 条原始笔画，安装后 219 个文件回读校验通过，28 份原生笔记哈希保持不变。设备启动和实际书写体验仍需用户试用确认；成功复制与校验不代表已经完成真机笔体验验收。

输入快照、解码向量、私人副本、文件清单、备份及运行记录均只存放在忽略跟踪的 `.test-data/notebook-preview-*`。这些目录包含私人内容，不能上传 GitHub 或作为公开安装包分发。
