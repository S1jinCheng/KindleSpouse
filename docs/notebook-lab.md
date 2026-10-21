# 原生 Notebook 连接测试

当前已按用户要求暂停此路线，不继续安装或操作设备。后续工作转入 [KOReader 内置 Notebook 电脑实验](../experiments/notebook/README.md)。以下保留现有诊断工具的使用记录，不代表建议继续进行真机测试。

已通过连接设备读取并确认：第一代 Kindle Scribe，Kindle 5.20.1（489393 050），KOReader v2026.07.1。

这是一套独立的诊断插件，不包含原生笔记格式的转换或写入。正式主页的 Notebook 行为尚未替换。测试目标是从 KOReader 正常保存退出后直接打开原生笔记本页面，并采集打开旧笔记、返回列表时的系统界面标识，以核实后续的指定笔记跳转和返回条件。

## 使用

退出 KOReader，连接 USB，运行 `scripts/install-notebook-lab.ps1`。安装器仅写入独立的 `koreader/plugins/kindlespouse-notebook-lab.koplugin` 与 `extensions/kindlespouse-notebook-lab` 目录，备份同名旧诊断文件并回读验证。现有 KOReader 启动器、同步配置和原生笔记保持原样。

拔掉 USB 并重新启动 KOReader。在书架顶部菜单第一个分页中找到“新：Notebook 连接测试”，选择“打开原生笔记本并记录跳转”。测试入口在阅读界面中禁用，请先回到书架。

插件检查父进程是 KOReader 启动器，保存启动器进程标识和启动时间，再正常保存、关闭书架。后台交接等待启动器完全退出，最多等待三十秒；进程身份改变或者未能正常退出时，不触发跳转。随后仅尝试一次以下原生界面入口：

`app://com.lab126.KPPMainApp?view=KPP_NOTEBOOK`

该入口来自 [Scribe 用户的原始接口实测记录](https://www.mobileread.com/forums/showthread.php?p=4389509)。它是需要在本机验证的候选入口，不保证适用于 5.20.1，也不是打开指定笔记本的接口。

打开一本旧笔记，确认原生编辑功能，再返回笔记本列表。等待约三分钟后连接 USB，运行 `scripts/collect-notebook-lab.ps1`，将最近一次采集读取到本机忽略跟踪的 `.test-data` 私有目录。无需 KUAL；已安装 KUAL 时也可使用独立诊断菜单。

## 采集范围

采集固件版本、KOReader 版本、应用管理器接口描述，以及变化时的 `activeView` 和 `ActiveContext`。应用注册库通过 SQLite 只读连接备份到诊断目录，以核实应用支持的路由；不修改系统数据库。导航记录可能包含私人笔记标识，不能提交到公开仓库。没有采集账户凭据、笔记正文或笔画文件。

插件不自动返回 KOReader，因为原生笔记编辑器的退出与保存信号尚未验证。测试记录只能证明实际捕获的跳转，不能证明指定笔记直达或无感切换已经完成。

移除时退出 KOReader，只需删除上述两个独立诊断目录；如需清理记录，可删除 `kindlespouse/notebook-lab`。不需要更改原笔记目录。

## 验证

在 Linux 或 WSL 中运行 `python3 tests/notebook-lab.py`，检查固定跳转、只读记录模式、启动失败、采集互斥、参数校验、启动器清理先于跳转以及进程身份变化保护。使用项目 KOReader 附带的 LuaJIT 在项目根目录运行 `tests/notebook-lab.lua`，检查菜单、设备限制和正常保存退出顺序。
