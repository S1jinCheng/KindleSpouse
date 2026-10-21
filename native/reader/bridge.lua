local UIManager = require("ui/uimanager")
local ReaderUI = require("apps/reader/readerui")
local Device = require("device")
local Event = require("ui/event")
local Geom = require("ui/geometry")
local json = require("json")
local root = os.getenv("KO_HOME")
local last_seq = -1
local started = os.time()
local heartbeat_seen = started
local heartbeat_marker
local initialized = false
local load_failed = false
local anchor_result
local sleep_widget
local sleep_preset
Device.openLink = function() return false end
local ReaderRolling = require("apps/reader/modules/readerrolling")
local engine_callback = ReaderRolling.handleEngineCallback
function ReaderRolling:handleEngineCallback(event, ...)
    if event == "OnLoadFileError" then load_failed = true end
    return engine_callback(self, event, ...)
end

local function read_json(name)
    local file = io.open(root .. "/" .. name, "rb")
    if not file then return nil end
    local text = file:read(131073)
    file:close()
    if #text > 131072 then return nil end
    local ok, value = pcall(json.decode, text)
    if ok then return value end
end

local function write_frame(seq, failure)
    local reader = ReaderUI.instance
    local state = { seq = seq, version = require("version"):getCurrentRevision(), width = Device.screen:getWidth(), height = Device.screen:getHeight() }
    if failure then
        state.error = failure
    elseif load_failed or reader and reader.document.provider == "crengine" and not reader.document._loaded then
        state.error = "KOReader could not open the document"
    elseif reader then
        state.anchorResult = anchor_result
        state.domVersion = reader.doc_settings and reader.doc_settings.readSetting and reader.doc_settings:readSetting("cre_dom_version")
        state.page = reader:getCurrentPage()
        state.pages = reader.document.getPageCount and reader.document:getPageCount() or reader.document.info.number_of_pages
        state.location = reader.document.getXPointer and reader.document:getXPointer() or tostring(state.page)
        state.font = reader.font and reader.font.font_face
        state.fontSize = reader.document.configurable and reader.document.configurable.font_size
        state.fontAvailable = true
        if reader.font and state.font then
            state.fontAvailable = false
            for _, name in ipairs(require("document/credocument"):engineInit().getFontFaces()) do
                if name == state.font then state.fontAvailable = true; break end
            end
        end
        state.toc = {}
        for _, item in ipairs(reader.document:getToc() or {}) do
            if #state.toc >= 500 then break end
            table.insert(state.toc, { label = item.title or "", page = item.page or 1 })
        end
        Device.screen:shot(root .. "/frame-" .. seq .. ".png")
    end
    local file = assert(io.open(root .. "/frame.json", "wb"))
    file:write(json.encode(state))
    file:close()
end

local function capture(seq)
    UIManager:scheduleIn(0.15, function()
        local ok = pcall(write_frame, seq)
        if not ok then pcall(write_frame, seq, "KOReader could not render this page") end
    end)
end

local function poll()
    local heartbeat = read_json("heartbeat.json")
    if heartbeat and type(heartbeat.at) == "number" and heartbeat.at ~= heartbeat_marker then
        heartbeat_marker = heartbeat.at
        heartbeat_seen = os.time()
    end
    if os.time() - heartbeat_seen > 30 then UIManager:quit(); return end
    local reader = ReaderUI.instance
    if reader and reader.postReaderReadyCallback == nil and not initialized then
        initialized = true
        for index = #UIManager._window_stack, 1, -1 do
            local widget = UIManager._window_stack[index].widget
            if widget == reader then break end
            UIManager:close(widget)
        end
        UIManager:setDirty("all", "full")
        if last_seq < 0 then last_seq = 0 end
        capture(last_seq)
    elseif initialized then
        local request = read_json("request.json")
        if request and type(request.seq) == "number" and request.seq > last_seq then
            last_seq = request.seq
            local ok = pcall(function()
                anchor_result = nil
                if sleep_widget then UIManager:close(sleep_widget); sleep_widget = nil; UIManager:setDirty("all", "full") end
                if request.action == "close" then UIManager:quit(); return end
                if request.action == "open" and type(request.filename) == "string" then
                    if request.filename:sub(1, #root + 11) ~= root .. "/documents/" or request.filename:find("/../", 1, true) then error("Invalid document path") end
                    initialized = false
                    load_failed = false
                    reader:switchDocument(request.filename, true)
                    return
                elseif request.action == "next" then UIManager:sendEvent(Event:new("GotoViewRel", 1))
                elseif request.action == "locate" and type(request.anchor) == "table" then
                    anchor_result = dofile(root .. "/annotations.lua").locate(reader, request.anchor, request.fileHash)
                elseif request.action == "sleep-cover" then
                    local data = { title = reader.doc_props.display_title or reader.doc_props.title, authors = reader.doc_props.authors,
                        page = reader:getCurrentPage(), doc_pages = reader.document:getPageCount() }
                    sleep_preset = sleep_preset or dofile(root .. "/sleep_cover.lua")
                    sleep_widget = sleep_preset.build(reader, nil, data, request.sleepProfile, request.sleepStats)
                    UIManager:show(sleep_widget)
                    UIManager:setDirty("all", "full")
                elseif request.action == "prev" then UIManager:sendEvent(Event:new("GotoViewRel", -1))
                elseif request.action == "page" and type(request.page) == "number" then UIManager:sendEvent(Event:new("GotoPage", math.max(1, math.floor(request.page))))
                elseif request.action == "tap" and type(request.x) == "number" and type(request.y) == "number" then
                    UIManager:sendEvent(Event:new("Gesture", { ges = "tap", pos = Geom:new{ x = math.max(0, math.min(Device.screen:getWidth() - 1, request.x)), y = math.max(0, math.min(Device.screen:getHeight() - 1, request.y)) } }))
                elseif request.action ~= "refresh" then error("Unsupported action") end
                capture(last_seq)
            end)
            if not ok then pcall(write_frame, last_seq, "KOReader could not handle this action") end
        end
    end
    UIManager:scheduleIn(0.15, poll)
end
UIManager:scheduleIn(0.5, poll)
