local source = debug.getinfo(1, "S").source
local root = assert(source:match("^@(.+)/patches/[^/]+$"))
local previous_path = package.path
package.path = root .. "/plugins/kindlespouse.koplugin/?.lua;" .. package.path
local Home = require("home")
package.path = previous_path
local Embedded = assert(loadfile(root .. "/kindlespouse-notebook/embedded.lua"))()
local engine = Embedded.new(root .. "/kindlespouse-notebook/engine")
if require("libs/libkoreader-lfs").attributes(root .. "/notebook/Scribe 可编辑副本", "mode") == "directory" then
    engine.folder = "Scribe 可编辑副本"
end
engine:install(Home)
package.loaded.kindlespouse_notebook_preview = engine
if not G_reader_settings:readSetting("kindlespouse_notebook_preview_installed") then
    G_reader_settings:saveSetting("kindlespouse_home", true)
    G_reader_settings:saveSetting("start_with", "filemanager")
    G_reader_settings:saveSetting("kindlespouse_notebook_preview_installed", true)
end
