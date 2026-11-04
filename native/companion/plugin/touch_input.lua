local Device = require("device")
local TouchInput = {}

function TouchInput.restore()
    if not G_reader_settings or not Device:isKindle() or not Device:isTouchDevice() then return false end
    G_reader_settings:saveSetting("virtual_keyboard_enabled", true)
    return true
end

function TouchInput.prepare()
    if not G_reader_settings or G_reader_settings:readSetting("kindlespouse_touch_input_ready") then return end
    if not Device:isKindle() or not Device:isTouchDevice() then return end
    G_reader_settings:saveSetting("kindlespouse_previous_virtual_keyboard", G_reader_settings:readSetting("virtual_keyboard_enabled"))
    TouchInput.restore()
    G_reader_settings:saveSetting("kindlespouse_touch_input_ready", true)
end

return TouchInput
