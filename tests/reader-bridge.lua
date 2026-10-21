local clock = 100
local heartbeat = "100"
local scheduled
local stopped = false
local UIManager = {}
function UIManager:scheduleIn(_, callback) scheduled = callback end
function UIManager:quit() stopped = true end
package.preload["ui/uimanager"] = function() return UIManager end
package.preload["apps/reader/readerui"] = function() return {} end
package.preload["device"] = function() return {} end
package.preload["ui/event"] = function() return {} end
package.preload["ui/geometry"] = function() return {} end
package.preload["apps/reader/modules/readerrolling"] = function() return { handleEngineCallback = function() end } end
package.preload["json"] = function()
    return { decode = function(text)
        if text == "partial" then error("Incomplete JSON") end
        return { at = tonumber(text) }
    end }
end
local actual_open = io.open
io.open = function(name, mode)
    if name == "reader-test/heartbeat.json" then
        if heartbeat == nil then return nil end
        return { read = function() return heartbeat end, close = function() end }
    end
    return actual_open(name, mode)
end
os.time = function() return clock end
os.getenv = function() return "reader-test" end
dofile("native/reader/bridge.lua")
local function tick(at, marker)
    clock = at
    heartbeat = marker
    local callback = assert(scheduled)
    scheduled = nil
    callback()
end
tick(100, "100")
tick(130, "130")
tick(131, "partial")
assert(not stopped, "An incomplete heartbeat write must not terminate a live reader")
tick(132, nil)
assert(not stopped, "A temporarily missing heartbeat must retain the last valid observation")
tick(133, "900000")
tick(162, "900000")
assert(not stopped, "Heartbeat grace must use local elapsed time rather than the host clock")
tick(164, "900000")
assert(stopped, "An abandoned reader must still stop after the heartbeat grace period")
print("Reader heartbeat: partial writes, missing files, host clock differences and orphan cleanup passed.")
