local tasks, frames, request = {}, {}, nil
local stopped, switches = false, 0
local UIManager = { _window_stack = {} }
function UIManager:scheduleIn(_, callback) tasks[#tasks + 1] = callback end
function UIManager:setDirty() end
function UIManager:quit() stopped = true end
local ReaderUI = {}
local function reader(ready)
    local value = { document = { provider = "pdf", getPageCount = function() return 2 end, getToc = function() return {} end } }
    if not ready then value.postReaderReadyCallback = {} end
    function value:getCurrentPage() return 1 end
    function value:switchDocument(filename)
        switches = switches + 1
        assert(filename == "reader-test/documents/new/book.epub")
        ReaderUI.instance = reader(false)
    end
    return value
end
ReaderUI.instance = reader(true)
package.preload["ui/uimanager"] = function() return UIManager end
package.preload["apps/reader/readerui"] = function() return ReaderUI end
package.preload["device"] = function() return { screen = { getWidth = function() return 1860 end, getHeight = function() return 2480 end, shot = function() end } } end
package.preload["ui/event"] = function() return {} end
package.preload["ui/geometry"] = function() return {} end
package.preload["apps/reader/modules/readerrolling"] = function() return { handleEngineCallback = function() end } end
package.preload["version"] = function() return { getCurrentRevision = function() return "v2026.07.1" end } end
package.preload["json"] = function()
    return { decode = function(text) return text == "heartbeat" and { at = 100 } or request end,
        encode = function(value) frames[#frames + 1] = value; return "frame" end }
end
local open, getenv, time = io.open, os.getenv, os.time
io.open = function(filename, mode)
    if mode == "wb" then return { write = function() end, close = function() end } end
    if filename == "reader-test/heartbeat.json" then return { read = function() return "heartbeat" end, close = function() end } end
    if filename == "reader-test/request.json" and request then return { read = function() return "request" end, close = function() end } end
end
os.getenv = function() return "reader-test" end
os.time = function() return 100 end
dofile("native/reader/bridge.lua")
local function tick() local callback = table.remove(tasks, 1); assert(callback); callback() end
local function until_frames(count)
    for attempt = 1, 10 do if #frames >= count then return end; tick() end
    assert(#frames >= count)
end
until_frames(1)
assert(frames[1].seq == 0 and frames[1].pages == 2)
request = { seq = 1, action = "open", filename = "reader-test/documents/new/book.epub" }
tick()
assert(switches == 1 and #frames == 1)
ReaderUI.instance.postReaderReadyCallback = nil
until_frames(2)
assert(frames[2].seq == 1 and not frames[2].error)
request = { seq = 2, action = "open", filename = "reader-test/documents/../private.epub" }
until_frames(3)
assert(switches == 1 and frames[3].seq == 2 and frames[3].error)
request = { seq = 3, action = "close" }
for attempt = 1, 3 do if stopped then break end; tick() end
assert(stopped)
io.open, os.getenv, os.time = open, getenv, time
print("Resident reader: sequenced document switch, ready callback, path restriction and shutdown passed.")
