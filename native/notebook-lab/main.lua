local WidgetContainer = require("ui/widget/container/widgetcontainer")
local UIManager = require("ui/uimanager")
local InfoMessage = require("ui/widget/infomessage")
local Device = require("device")
local Lab = WidgetContainer:extend { name = "kindlespouse_notebook_lab", is_doc_only = false }
local script = "/mnt/us/koreader/plugins/kindlespouse-notebook-lab.koplugin/probe.sh"

local function read(filename)
    local file = io.open(filename, "r")
    if not file then return end
    local data = file:read(16384)
    file:close()
    return data
end

function Lab:init()
    self.ui.menu:registerToMainMenu(self)
end

function Lab:start()
    if not Device:isKindle() or self.ui.document then return end
    local status = read("/proc/self/status")
    local parent = status and status:match("PPid:%s*(%d+)")
    local command = parent and read("/proc/" .. parent .. "/cmdline")
    local stat = parent and read("/proc/" .. parent .. "/stat")
    local fields = stat and stat:match("^%d+ %b() (.*)")
    local index, stamp = 0
    for value in (fields or ""):gmatch("%S+") do
        index = index + 1
        if index == 20 then stamp = value; break end
    end
    if not command or not command:find("/koreader.sh", 1, true) or not stamp or not stamp:match("^%d+$") or not read(script) then
        UIManager:show(InfoMessage:new { text = "当前启动方式不支持安全跳转，未退出 KOReader。" })
        return
    end
    local result = os.execute("sh " .. script .. " handoff " .. parent .. " " .. stamp .. " < /dev/null > /dev/null 2>&1 &")
    if result ~= 0 then
        UIManager:show(InfoMessage:new { text = "无法启动笔记本测试，未退出 KOReader。" })
        return
    end
    self.ui:onClose()
    UIManager:quit()
end

function Lab:addToMainMenu(items)
    items.kindlespouse_notebook_lab = {
        text = "Notebook 连接测试",
        enabled_func = function() return Device:isKindle() and not self.ui.document end,
        sub_item_table = {
            { text = "打开原生笔记本并记录跳转", callback = function() self:start() end },
        },
    }
end

return Lab
