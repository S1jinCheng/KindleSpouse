local settings = {}
local kindle, touch = true, true
package.path = "native/companion/plugin/?.lua;" .. package.path
package.preload["device"] = function() return {
    isKindle = function() return kindle end,
    isTouchDevice = function() return touch end,
} end
G_reader_settings = {
    readSetting = function(_, name) return settings[name] end,
    saveSetting = function(_, name, value) settings[name] = value end,
}
local TouchInput = require("touch_input")
TouchInput.prepare()
assert(settings.virtual_keyboard_enabled and settings.kindlespouse_touch_input_ready)
settings.virtual_keyboard_enabled = false
TouchInput.prepare()
assert(settings.virtual_keyboard_enabled == false)
assert(TouchInput.restore() and settings.virtual_keyboard_enabled)
settings = { virtual_keyboard_enabled = false }
TouchInput.prepare()
assert(settings.kindlespouse_previous_virtual_keyboard == false and settings.virtual_keyboard_enabled)
settings = {}
kindle = false
TouchInput.prepare()
assert(settings.virtual_keyboard_enabled == nil and not TouchInput.restore())
kindle, touch = true, false
TouchInput.prepare()
assert(settings.virtual_keyboard_enabled == nil and not TouchInput.restore())
print("Touch keyboard preference migration and recovery passed")
