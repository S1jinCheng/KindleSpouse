local events, notices, files = {}, {}, {}
local kindle = true
package.loaded["ui/widget/container/widgetcontainer"] = {
    extend = function(_, value) return value end,
}
package.loaded["ui/uimanager"] = {
    show = function(_, value) notices[#notices + 1] = value.text end,
    quit = function() events[#events + 1] = "quit" end,
}
package.loaded["ui/widget/infomessage"] = { new = function(_, value) return value end }
package.loaded.device = { isKindle = function() return kindle end }
local Lab = dofile("native/notebook-lab/main.lua")
local original_open, original_execute = io.open, os.execute
io.open = function(filename)
    local value = files[filename]
    if not value then return end
    return { read = function() return value end, close = function() end }
end
os.execute = function(command)
    events[#events + 1] = command
    return 0
end
local ui = { menu = { registerToMainMenu = function(_, plugin) assert(plugin == Lab) end },
    onClose = function() events[#events + 1] = "save_and_close" end }
Lab.ui = ui
Lab:init()
local items = {}
Lab:addToMainMenu(items)
assert(items.kindlespouse_notebook_lab.text == "Notebook 连接测试")
assert(items.kindlespouse_notebook_lab.enabled_func())
Lab:start()
assert(#events == 0 and #notices == 1)
files["/proc/self/status"] = "Name:\treader.lua\nPPid:\t1234\n"
files["/proc/1234/cmdline"] = "/bin/sh\0/var/tmp/koreader.sh\0--kual\0"
files["/proc/1234/stat"] = "1234 (koreader.sh) S " .. string.rep("1 ", 18) .. "987654 1\n"
files["/mnt/us/koreader/plugins/kindlespouse-notebook-lab.koplugin/probe.sh"] = "umask 077\n"
Lab:start()
assert(#events == 3)
assert(events[1] == "sh /mnt/us/koreader/plugins/kindlespouse-notebook-lab.koplugin/probe.sh handoff 1234 987654 < /dev/null > /dev/null 2>&1 &")
assert(events[2] == "save_and_close" and events[3] == "quit")
events = {}
files["/proc/1234/cmdline"] = "/bin/sh\0unrelated-launcher\0"
Lab:start()
assert(#events == 0 and #notices == 2)
ui.document = {}
assert(not items.kindlespouse_notebook_lab.enabled_func())
Lab:start()
assert(#events == 0)
ui.document = nil
kindle = false
assert(not items.kindlespouse_notebook_lab.enabled_func())
Lab:start()
assert(#events == 0)
io.open, os.execute = original_open, original_execute
print("Notebook Lab: menu, safe launcher identity, save-before-exit, unsupported launchers and device guards passed.")
