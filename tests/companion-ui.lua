local files, decoded, shown, tasks = {}, {}, {}, {}
local launches, redraws = 0, 0
local connected = true
local reader, saves, save_failed, annotation_count = {}, 0, false, 0
local directory = "/mnt/us/kindlespouse/"
local function copy(value)
    local result = {}
    for key, item in pairs(value) do result[key] = item end
    return result
end
local function put(name, value)
    files[directory .. name] = name
    decoded[name] = value
end
local function class()
    local result = {}
    function result:extend(values) return setmetatable(values, { __index = self }) end
    function result:new(values) return setmetatable(values or {}, { __index = self }) end
    return result
end
local Widget = class()
local Notification = class()
local InfoMessage = class()
function InfoMessage:free() end
function InfoMessage:init() end
function InfoMessage:getVisibleArea() return {} end
local UIManager = {}
function UIManager:show(widget) shown[#shown + 1] = widget end
function UIManager:close(widget) if widget.dismiss_callback then widget.dismiss_callback() end end
function UIManager:scheduleIn(delay, callback) tasks[callback] = delay end
function UIManager:unschedule(callback) tasks[callback] = nil end
function UIManager:setDirty() redraws = redraws + 1 end
package.preload["ui/widget/container/widgetcontainer"] = function() return Widget end
package.preload["ui/uimanager"] = function() return UIManager end
package.preload["ui/widget/infomessage"] = function() return InfoMessage end
package.preload["ui/widget/notification"] = function() return Notification end
package.preload["ui/network/manager"] = function() return { isConnected = function() return connected end } end
package.preload["libs/libkoreader-lfs"] = function()
    return { attributes = function(filename) return files[filename] and "file" end }
end
package.preload["json"] = function()
    return { decode = function(value) if not decoded[value] then error("invalid json") end; return copy(decoded[value]) end }
end
package.preload["apps/reader/readerui"] = function() return reader end
package.preload["annotation_apply"] = function()
    return { run = function() local count = annotation_count; annotation_count = 0; return count end }
end
local open, execute, remove = io.open, os.execute, os.remove
os.remove = function(filename)
    if filename:match("^/mnt/us/") then files[filename] = nil; return true end
    return remove(filename)
end
io.open = function(filename, mode)
    if not filename:match("^/mnt/us/") and not filename:match("^/proc/") then return open(filename) end
    if mode == "w" then
        files[filename] = ""
        return { write = function(_, value) files[filename] = files[filename] .. value end, close = function() end }
    end
    if files[filename] == nil then return nil end
    return { read = function() return files[filename] end, close = function() end }
end
os.execute = function() launches = launches + 1; return 0 end
local Companion = dofile("native/companion/plugin/main.lua")
local function instance()
    local plugin = Companion:new { ui = { menu = { registerToMainMenu = function() end } } }
    plugin:init()
    return plugin
end
local function tick(callback)
    tasks[callback] = nil
    callback()
end
local plugin = instance()
assert(tasks[plugin.auto_receive_task] == 8)
assert(plugin:status().state == "idle")
files[directory .. "last-result.json"] = ""
assert(plugin:summary(plugin:status()) ~= "")
files[directory .. "sync.lock"] = ""
assert(plugin:status().state == "failed")
files[directory .. "sync.lock"] = nil
files[directory .. "config.json"] = "paired"
plugin:sync(false)
assert(launches == 1 and #shown == 1)
assert(shown[1].toast == true and shown[1].timeout == 3)
assert(getmetatable(shown[1]).__index == Notification)
plugin:sync(false)
assert(launches == 1)
files[directory .. "sync.lock"] = "123\n"
files["/proc/123/cmdline"] = "./kindlespouse-sync\0--config\0/mnt/us/kindlespouse/config.json"
put("progress.json", { state = "running", stage = "uploading_notes", done = 3, total = 12, startedAt = os.time() })
local before = #shown
for attempt = 1, 4 do tick(plugin.watch_task) end
assert(#shown == before and redraws == 0)
assert(plugin:summary(plugin:status()):find("3/12", 1, true))
plugin:showStatus()
local dialog = plugin.status_dialog
assert(dialog and dialog.text:find("3/12", 1, true))
local refresh
for callback, delay in pairs(tasks) do if delay == 3 then refresh = callback end end
assert(refresh)
put("progress.json", { state = "running", stage = "uploading_notes", done = 4, total = 12, startedAt = os.time() })
tick(refresh)
assert(dialog.text:find("4/12", 1, true) and redraws == 2)
UIManager:close(dialog)
assert(not tasks[refresh] and plugin.watch_task)
files[directory .. "sync.lock"] = nil
put("progress.json", { state = "completed", received = 1, files = 12, startedAt = os.time() })
tick(plugin.watch_task)
assert(shown[#shown].toast == true and shown[#shown].text:find("complete", 1, true))
assert(not plugin.watch_task)
local count = #shown
local silent = instance()
silent:sync(true)
assert(#shown == count)
put("progress.json", { state = "failed", error = "cloud operation failed", startedAt = os.time() })
tick(silent.watch_task)
assert(#shown == count and silent:summary(silent:status()):find("cloud operation failed", 1, true))
local stale = instance()
put("progress.json", { state = "completed", received = 0, files = 1, startedAt = os.time() - 60 })
stale:sync(false)
for attempt = 1, 3 do tick(stale.watch_task) end
assert(stale:status().state == "failed")
assert(not shown[#shown].text:find("sync complete", 1, true))
local offline = instance()
connected = false
count = launches
offline:sync(false)
assert(launches == count and shown[#shown].toast)
connected = true
local paused = instance()
files[directory .. "sync.lock"] = "123\n"
put("progress.json", { state = "running", stage = "uploading_notes", done = 4, total = 12, startedAt = os.time() })
paused:pause()
assert(paused:status().state == "pausing")
files[directory .. "sync.lock"] = nil
assert(paused:status().state == "paused")
count = launches
paused:sync(true)
assert(launches == count)
tick(paused.watch_task)
assert(not paused.watch_task)
paused:syncTitles()
assert(launches == count + 1 and files[directory .. "pause.requested"])
put("progress.json", { state = "completed", titlesOnly = true, startedAt = os.time(), files = 2 })
tick(paused.watch_task)
assert(shown[#shown].text:find("titles synced", 1, true))
assert(files[directory .. "pause.requested"])
paused:sync(false)
assert(not files[directory .. "pause.requested"])
local collector = instance()
local batch_status = collector:summary({ state = "running", stage = "uploading_bundles", done = 1, total = 3, bytes = 1048576, totalBytes = 3145728, speed = 524288 })
assert(batch_status:find("sync bundles", 1, true) and batch_status:find("1.0/3.0 MiB", 1, true) and batch_status:find("512 KiB/s", 1, true))
connected = false
count = launches
collector:collectTitles()
assert(launches == count + 1)
connected = true
local settings = {}
G_reader_settings = {
    readSetting = function(_, name, default) if settings[name] ~= nil then return settings[name] end; return default end,
    saveSetting = function(_, name, value) settings[name] = value end,
}
local priority = instance()
priority:sync(false)
put("progress.json", { state = "running", stage = "uploading_notes", done = 1, total = 100, startedAt = os.time() })
put("sleep-profile.json", { version = 1, revision = "new-photo", enabled = true })
files[directory .. "sync.lock"] = "123\n"
tick(priority.watch_task)
assert(settings.kindlespouse_sleep_revision == "new-photo" and settings.screensaver_type == "customisable_ss")
assert(priority.watch_task and priority:status().state == "running")
assert(priority:summary({ state = "running", stage = "receiving_profile" }):find("profile", 1, true))
files[directory .. "sync.lock"] = nil
put("progress.json", { state = "completed", startedAt = os.time() })
files[directory .. "pause.requested"] = "notes stay paused"
files[directory .. "profile-pause.requested"] = "paused"
local local_profile = instance()
count = launches
local_profile:syncProfile()
assert(launches == count + 1 and files[directory .. "pause.requested"] == "notes stay paused")
assert(not files[directory .. "profile-pause.requested"])
put("progress.json", { state = "completed", profileOnly = true, profileRoute = "lan", startedAt = os.time() })
tick(local_profile.watch_task)
assert(shown[#shown].text:find("local network", 1, true))
assert(local_profile:status().state == "completed" and files[directory .. "pause.requested"])
assert(local_profile:summary({ state = "completed", profileOnly = true, profileRoute = "cloud" }):find("cloud", 1, true))
connected = false
count = launches
local_profile:syncProfile()
assert(launches == count)
connected = true
files[directory .. "sync.lock"] = "123\n"
local_profile:syncProfile()
assert(launches == count and shown[#shown].text:find("pause the current sync", 1, true))
G_reader_settings = nil
files[directory .. "sync.lock"] = nil
files[directory .. "pause.requested"] = nil
files[directory .. "books-pause.requested"] = nil
put("progress.json", { state = "completed", startedAt = os.time() })
local automatic = instance()
count = launches
local notifications = #shown
tick(automatic.auto_receive_task)
assert(launches == count + 1 and #shown == notifications)
assert(tasks[automatic.auto_receive_task] == 90)
tick(automatic.auto_receive_task)
assert(launches == count + 1)
automatic:onSuspend()
assert(not tasks[automatic.auto_receive_task])
automatic:onResume()
assert(tasks[automatic.auto_receive_task] == 8)
automatic:onCloseWidget()
assert(not tasks[automatic.auto_receive_task])
local auto_paused = instance()
files[directory .. "books-pause.requested"] = "paused"
count = launches
tick(auto_paused.auto_receive_task)
assert(launches == count)
files[directory .. "books-pause.requested"] = nil
connected = false
tick(auto_paused.auto_receive_task)
assert(launches == count)
connected = true
files[directory .. "books-pause.requested"] = nil
files[directory .. "pause.requested"] = nil
settings = {}
G_reader_settings = {
    readSetting = function(_, name, default) if settings[name] ~= nil then return settings[name] end; return default end,
    saveSetting = function(_, name, value) settings[name] = value end,
}
local time = os.time
local now = time() + 100
os.time = function() return now end
reader.instance = { document = {}, saveSettings = function() if save_failed then error("cannot save") end; saves = saves + 1 end }
local full = instance()
assert(tasks[full.auto_sync_task] == 6)
count, notifications = launches, #shown
tick(full.auto_sync_task)
assert(launches == count + 1 and saves == 1 and #shown == notifications)
assert(tasks[full.auto_sync_task] == 30)
tick(full.auto_receive_task)
assert(launches == count + 1)
put("progress.json", { state = "completed", startedAt = now })
tick(full.watch_task)
assert(settings.kindlespouse_last_sync == now and not settings.kindlespouse_sync_dirty)
now = now + 299
tick(full.auto_sync_task)
assert(launches == count + 1)
now = now + 1
tick(full.auto_sync_task)
assert(launches == count + 1)
full:onPageUpdate(2)
local generation = settings.kindlespouse_sync_generation
full:onPageUpdate(2)
assert(settings.kindlespouse_sync_generation == generation)
now = now + 300
tick(full.auto_sync_task)
assert(launches == count + 2)
full:onAnnotationsModified()
assert(tasks[full.auto_sync_task] == 15)
put("progress.json", { state = "completed", startedAt = now })
tick(full.watch_task)
assert(settings.kindlespouse_sync_dirty)
now = now + 15
tick(full.auto_sync_task)
assert(launches == count + 2)
now = now + 45
tick(full.auto_sync_task)
assert(launches == count + 3)
put("progress.json", { state = "failed", startedAt = now, error = "offline" })
tick(full.watch_task)
now = now + 30
tick(full.auto_sync_task)
assert(launches == count + 3)
now = now + 30
tick(full.auto_sync_task)
assert(launches == count + 4)
put("progress.json", { state = "completed", startedAt = now })
tick(full.watch_task)
assert(not settings.kindlespouse_sync_dirty and #shown == notifications)
full:onSuspend()
assert(not tasks[full.auto_sync_task] and not tasks[full.auto_receive_task])
now = now + 400
full:automaticSync()
full:receiveBooks(true)
assert(launches == count + 4)
full:onResume()
assert(tasks[full.auto_sync_task] == 6 and tasks[full.auto_receive_task] == 8)
full.retry_after = now + 900
full:onNetworkConnected()
assert(full.retry_after == nil and tasks[full.auto_sync_task] == 6)
connected = false
tick(full.auto_sync_task)
assert(launches == count + 4)
connected = true
files[directory .. "pause.requested"] = "paused"
tick(full.auto_sync_task)
assert(launches == count + 4 and files[directory .. "pause.requested"])
files[directory .. "pause.requested"] = nil
settings.kindlespouse_auto_sync = false
full:onCloseDocument()
tick(full.auto_sync_task)
assert(launches == count + 4)
settings.kindlespouse_auto_sync = true
save_failed = true
tick(full.auto_sync_task)
assert(launches == count + 4)
save_failed = false
now = now + 60
tick(full.auto_sync_task)
assert(launches == count + 5)
put("progress.json", { state = "completed", startedAt = now })
tick(full.watch_task)
annotation_count = 1
full:applyAnnotations()
assert(settings.kindlespouse_sync_dirty and tasks[full.auto_sync_task] == 15 and #shown == notifications)
full:onCloseWidget()
assert(not tasks[full.auto_sync_task] and not tasks[full.auto_receive_task])
local quiet = instance()
quiet.auto_sync_check = false
settings.kindlespouse_sync_dirty = false
settings.kindlespouse_reading_dirty = false
local last_full = settings.kindlespouse_last_sync
now = now + 600
count, generation = launches, saves
tick(quiet.auto_sync_task)
assert(launches == count + 1 and saves == generation)
put("progress.json", { state = "completed", updatesOnly = true, startedAt = now })
tick(quiet.watch_task)
assert(settings.kindlespouse_last_sync == last_full and settings.kindlespouse_last_updates == now)
now = now + 30
tick(quiet.auto_sync_task)
assert(launches == count + 1)
put("progress.json", { state = "completed", booksOnly = true, startedAt = now })
files[directory .. "pause.requested"] = "notes paused"
assert(full:status().state == "completed")
os.time = time
io.open, os.execute, os.remove = open, execute, remove
print("Companion UI passed: automatic two-way sync, safe reader flush, incremental intervals, edits during upload, retry backoff, suspend/resume, pause, nonblocking progress and independent book receipt.")
