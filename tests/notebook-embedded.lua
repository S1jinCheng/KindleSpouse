local UIManager = require("ui/uimanager")
local FileManager = require("apps/filemanager/filemanager")
local Device = require("device")
local Screen = Device.screen
local project = assert(os.getenv("KINDLESPOUSE_TEST_ROOT"))
local root = assert(os.getenv("KINDLESPOUSE_NOTEBOOK_TEST_ROOT"))
local output = os.getenv("KINDLESPOUSE_TEST_OUTPUT") or project .. "/artifacts"
local experiment = os.getenv("KINDLESPOUSE_NOTEBOOK_EXPERIMENT") or project .. "/experiments/notebook"
local engine_directory = os.getenv("KINDLESPOUSE_NOTEBOOK_ENGINE") or project .. "/native/tools/notebook-koplugin/lua"
Device.hasKeyboard = function() return false end
Device.hasKeys = function() return false end
require("ui/widget/menu").is_enable_shortcut = false
require("ui/widget/filechooser").is_enable_shortcut = false
package.path = (os.getenv("KINDLESPOUSE_TEST_PLUGIN") or project .. "/native/companion/plugin") .. "/?.lua;" .. package.path
local Home = require("home")
local Embedded = assert(loadfile(experiment .. "/embedded.lua"))()
local Import = assert(loadfile(experiment .. "/import.lua"))()
local engine = Embedded.new(engine_directory)
engine:install(Home)
local Library, Document, Stroke = engine.load("library"), engine.load("document"), engine.load("stroke")
assert(Library.ensureDir(""))
local titles = { "日常随记", "阅读摘记", "灵感手账", "工作思考", "旅行计划", "我的草稿", "春日计划", "读书清单", "旅行手记", "每日记录", "晨间随笔", "摘录与想法" }
for index, title in ipairs(titles) do
    local document = Document:new(Library.abs(title .. ".scribe"))
    document:setTemplate(index % 2 == 0 and "grid" or "ruled")
    document.page_size = { w = 1860, h = 2200 }
    document.content_origin = { x = 0, y = 160 }
    for line = 1, 7 do
        for word = 1, 3 do
            local stroke = Stroke:new { tool = "pen", width = 4 + index % 3 }
            for point = 0, 80 do
                stroke:addPoint(150 + (word - 1) * 450 + point * 4,
                    380 + line * 170 + math.sin(point * 0.55 + index) * 36 + math.sin(point * 0.16) * 15, 0.7 + math.sin(point) * 0.2)
            end
            document:addStroke(stroke)
        end
    end
    document:addPage()
    document:goToPage(1)
    assert(document:save())
end
local Profile = require("profile")
local companion = { directory = root .. "/companion", notify = function() end }
assert(require("libs/libkoreader-lfs").mkdir(companion.directory))
local function fixture(name, value)
    local file = assert(io.open(companion.directory .. "/" .. name, "wb"))
    file:write(require("json").encode(value)); file:close()
end
fixture("config.json", { version = 1, name = "Kindle Scribe" })
local reading = { asOf = os.date("!%Y-%m-%d", os.time() + 28800), totalSeconds = 0, todaySeconds = 2820, readingDays = 0, bookCount = 18, days = {} }
local year, month, day = reading.asOf:match("^(%d+)%-(%d+)%-(%d+)$")
local today = os.time { year = tonumber(year), month = tonumber(month), day = tonumber(day), hour = 12 }
for offset = 0, 363 do
    if offset % 5 ~= 0 or offset == 0 then
        local seconds = offset == 0 and reading.todaySeconds or ({ 300, 900, 1800, 3600, 4800 })[offset % 5 + 1]
        reading.days[#reading.days + 1] = { date = os.date("%Y-%m-%d", today - offset * 86400), seconds = seconds }
        reading.totalSeconds = reading.totalSeconds + seconds
        reading.readingDays = reading.readingDays + 1
    end
end
fixture("sleep-profile.json", { version = 1, displayName = "KindleSpouse 读者", avatar = "KS", clouds = {
    { id = "reading", name = "阅读书库", provider = "drive", connected = true },
    { id = "backup", name = "笔记备份", provider = "onedrive", connected = false },
}, reading = reading })
fixture("progress.json", { state = "completed", completedAt = os.time(), received = 3, files = 28 })
function companion:status() return Profile.read(self.directory, "progress.json") end
function companion:syncProfile() fixture("progress.json", { state = "running", stage = "receiving_local_profile", profileOnly = true, done = 0, total = 1 }) end
function companion:sync() fixture("progress.json", { state = "running", stage = "uploading_bundles", done = 1, total = 4 }) end
function companion:pause() fixture("progress.json", { state = "paused" }) end
local recent_file = root .. "/books/阅读的四季.epub"
require("readhistory").hist = { { file = recent_file, time = os.time() } }
local original_init = FileManager.init
function FileManager:init()
    local original_setup, installed = self.setupLayout, false
    self.setupLayout = function(manager)
        if not installed then
            installed = true
            companion.ui = manager
            Home.install(companion)
        end
        return original_setup(manager)
    end
    original_init(self)
end

local failed = false
local function check(callback)
    local ok, error = pcall(callback)
    if not ok then
        failed = true
        print("EMBEDDED NOTEBOOK FAILED: " .. tostring(error))
        UIManager:quit(1)
    end
end
local function shot(ui, name)
    UIManager:widgetRepaint(ui, 0, 0)
    Screen:shot(output .. "/notebook-embedded-" .. name .. ".png")
end
local ui, editor, original_count
local Event = require("ui/event")
local Geom = require("ui/geometry")
local function swipe(view, direction, distance)
    view:handleEvent(Event:new("Gesture", { ges = "swipe", pos = Geom:new { x = 200, y = view.dimen.y + 200 }, direction = direction, distance = distance }))
end
local function tap(view, card, gesture)
    view:handleEvent(Event:new("Gesture", { ges = gesture or "tap", pos = Geom:new {
        x = card.dimen.x + 40, y = math.max(card.dimen.y + 40, view.dimen.y + 20) } }))
end
local function findCard(widget, path)
    if widget.entry and widget.entry.path == path and widget.onTap then return widget end
    for _, child in ipairs(widget) do
        if type(child) == "table" then
            local found = findCard(child, path)
            if found then return found end
        end
    end
end
UIManager:tickAfterNext(function()
UIManager:scheduleIn(6, function() check(function()
    ui = assert(FileManager.instance)
    assert(require("library").fonts.title == "NotoSerifCJKsc-Regular.otf" and require("library").fonts.ui == "NotoSansCJKsc-Regular.otf")
    shot(ui, "library")
    assert(ui.kindlespouse_shelf and ui.kindlespouse_shelf.list_view and ui.kindlespouse_shelf.columns == 1)
    assert(ui.kindlespouse_recent.file == recent_file)
    require("library").refresh(ui, { query = "慢慢走" })
    shot(ui, "recent-filtered")
    assert(#ui.file_chooser.item_table == 1 and ui.kindlespouse_recent.file == recent_file)
    local ReaderUI = require("apps/reader/readerui")
    local opened, original_open = nil, ReaderUI.showReader
    ReaderUI.showReader = function(_, file) opened = file end
    local recent = ui.kindlespouse_recent
    ui[1]:handleEvent(Event:new("Gesture", { ges = "tap", pos = Geom:new { x = recent.dimen.x + recent.dimen.w / 2, y = recent.dimen.y + 4 } }))
    ReaderUI.showReader = original_open
    assert(opened == recent_file, "Protruding recent cover must open the previous book, even when filtered out")
    require("library").refresh(ui, { query = "" })
    UIManager:widgetRepaint(ui, 0, 0)
    ui.kindlespouse_profile:onProfile()
    local panel = assert(companion.profile_panel)
    assert(panel.data.paired and panel.data.name == "KindleSpouse 读者" and #panel.data.clouds == 2)
    assert(panel.data.reading.readingDays == reading.readingDays and panel.metrics[1][2] == "47 分钟")
    shot(panel, "profile")
    local calendar = assert(panel.calendar)
    assert(#calendar.cells == 364 and calendar.dimen.y + calendar.dimen.h < Screen:getHeight())
    local selected
    for index, cell in ipairs(calendar.cells) do if cell.date == reading.asOf then selected = index end end
    assert(selected and calendar.cells[selected].level == 3)
    panel:handleEvent(Event:new("Gesture", { ges = "tap", pos = Geom:new {
        x = calendar.dimen.x + calendar.left + math.floor((selected - 1) / 7) * calendar.step + 2,
        y = calendar.dimen.y + calendar.top + (selected - 1) % 7 * calendar.step + 2 } }))
    assert(calendar.selected == selected and calendar.detail.text == reading.asOf .. "\n阅读 47 分钟", "Calendar taps must show the correct date and duration")
    shot(calendar.detail, "profile-day")
    UIManager:close(calendar.detail)
    panel.actions:getButtonById("profile").callback()
    assert(panel.data.state == "running" and not panel.actions:getButtonById("sync").enabled)
    shot(panel, "profile-syncing")
    panel.actions:getButtonById("pause").callback()
    assert(panel.data.state == "paused" and panel.actions:getButtonById("sync").text == "继续同步")
    panel.actions:getButtonById("sync").callback()
    assert(panel.data.state == "running" and panel.data.detail:find("1/4", 1, true))
    fixture("progress.json", { state = "failed" })
    panel:refreshNow()
    assert(panel.data.state == "failed" and panel.actions:getButtonById("sync").enabled)
    fixture("progress.json", { state = "completed", received = 3, files = 28, completedAt = os.time() })
    panel:refreshNow()
    UIManager:close(panel)
    assert(panel.closed and companion.profile_panel == nil)
    assert(os.rename(companion.directory .. "/config.json", companion.directory .. "/config.saved"))
    local unpaired = Profile.open(companion)
    assert(not unpaired.data.paired and not unpaired.actions:getButtonById("profile").enabled and not unpaired.actions:getButtonById("sync").enabled)
    UIManager:close(unpaired)
    assert(os.rename(companion.directory .. "/config.saved", companion.directory .. "/config.json"))
    local original_profile = Profile.read(companion.directory, "sleep-profile.json")
    fixture("sleep-profile.json", { version = 1, displayName = "尚无统计的读者" })
    local missing = Profile.open(companion)
    assert(not missing.data.reading and not missing.calendar and not missing.metrics)
    UIManager:close(missing)
    fixture("sleep-profile.json", { version = 1, reading = { asOf = reading.asOf, totalSeconds = 0, todaySeconds = 0, readingDays = 0, bookCount = 0, days = {} } })
    local empty = Profile.open(companion)
    assert(empty.metrics[2][2] == "0 分钟" and empty.metrics[4][2] == "0 天" and #empty.calendar.cells == 364)
    UIManager:close(empty)
    fixture("sleep-profile.json", original_profile)
    require("library").refresh(ui, { view = "grid" })
    shot(ui, "library-grid")
    assert(ui.kindlespouse_shelf.columns == 3)
    for _, card in pairs(ui.kindlespouse_shelf.cards) do assert(card.caption.text and card.caption.text ~= "") end
    local books = ui.kindlespouse_shelf
    if books._max_scroll_offset_y > 300 then
        swipe(books, "north", 300)
        assert(books:getScrolledOffset().y == 300)
        shot(ui, "library-scrolled")
        local index = (math.ceil(300 / books.row_h) * books.columns) + 1
        local card = assert(books.cards[index])
        local opened, original_open = nil, books.on_open
        books.on_open = function(item) opened = item end
        tap(books, card)
        assert(opened == books.items[index], "Scrolled cover taps must open the correct book")
        books.on_open = original_open
        ui.layout[#ui.layout][2].callback()
        ui.layout[#ui.layout][1].callback()
        assert(ui.kindlespouse_shelf:getScrolledOffset().y == 300, "Library position must survive tab switching")
        ui.kindlespouse_shelf:setScrolledOffset({ y = 0 })
    end
    local many = {}
    for index = 1, 1000 do many[index] = { title = "图书 " .. index } end
    local large = require("shelf"):new { dimen = Geom:new { w = Screen:getWidth(), h = 1000 }, items = many,
        provider = function(item) return item end, on_open = function() end }
    large:paintTo(Screen.bb, 0, 0)
    swipe(large, "north", 1000000)
    large:paintTo(Screen.bb, 0, 0)
    local live = 0
    for _ in pairs(large.cards) do live = live + 1 end
    assert(live < 20 and large.cards[1000], "Large libraries must render only visible cards and reach the last book")
    large:free()
    ui.layout[#ui.layout][2].callback()
    assert(ui.kindlespouse_tab == "Notebook" and engine.gallery)
    assert(#engine.gallery.items == #titles)
end) end)
UIManager:scheduleIn(10, function() check(function()
    shot(ui, "gallery")
    local view = engine.gallery.shelf
    assert(view._max_scroll_offset_y > 0 and view.swipe_full_view == false)
    swipe(view, "north", 300)
    assert(view:getScrolledOffset().y == 300, "Swipe distance must scroll without page snapping")
    shot(ui, "scrolled")
    ui.layout[#ui.layout][1].callback()
    ui.layout[#ui.layout][2].callback()
    view = engine.gallery.shelf
    assert(view:getScrolledOffset().y == 300, "Notebook position must survive tab switching")
    shot(ui, "restored")
    local selected_index = math.ceil(300 / view.row_h) * view.columns + 1
    local selected_path = view.items[selected_index].path
    tap(view, assert(view.cards[selected_index]), "hold")
    assert(engine.gallery.selection[selected_path], "Long press after scrolling must select the correct notebook")
    shot(ui, "selection")
    local selected_card = assert(findCard(engine.gallery, selected_path))
    assert(selected_card.caption.text:find("✓", 1, true), "Selected notebooks must be visibly marked")
    engine.gallery:_endSelection()
    view = engine.gallery.shelf
    shot(ui, "deselected")
    swipe(view, "south", 300)
    assert(view:getScrolledOffset().y == 0)
    local navigation = ui.layout[#ui.layout]
    assert(navigation[1].dimen.y + navigation[1]:getSize().h <= Screen:getHeight())
    engine.gallery.query = "阅读"
    engine.gallery:_rebuild()
    assert(#engine.gallery.items == 1 and engine.gallery.items[1].name == "阅读摘记")
    assert(ui.kindlespouse_search_label.text == "阅读", "Notebook search must use its own query")
    engine.gallery.query = ""
    engine.gallery:_rebuild()
    assert(#engine.gallery.items == #titles)
    assert(ui.kindlespouse_search_label.text == "搜索笔记本")
    shot(ui, "filtered")
    local card = assert(findCard(engine.gallery, engine.gallery.items[1].path))
    tap(engine.gallery.shelf, card)
    editor = assert(engine.editor)
    assert(editor.document:pageCount() == 2)
    original_count = #editor.document:getPage().strokes
    assert(original_count == 21)
    editor.canvas.draw_with_finger = true
    local y = editor.canvas.content.y + 170
    editor.canvas:onTouchStart(nil, { pos = { x = 230, y = y } })
    for point = 1, 40 do
        editor.canvas:onTouchPan(nil, { pos = { x = 230 + point * 14, y = y + math.sin(point * 0.3) * 36 } })
    end
    editor.canvas:onTouchRelease(nil, { pos = { x = 790, y = y } })
    assert(#editor.document:getPage().strokes == original_count + 1, "Touch input must add a saved vector stroke")
    editor.undo_button.callback()
    assert(#editor.document:getPage().strokes == original_count)
    editor.redo_button.callback()
    assert(#editor.document:getPage().strokes == original_count + 1)
    editor.canvas.tool = "eraser"
    editor.canvas.eraser_mode = "stroke"
    editor.canvas:onTouchStart(nil, { pos = { x = 230, y = y } })
    editor.canvas:onTouchRelease(nil, { pos = { x = 230, y = y } })
    assert(#editor.document:getPage().strokes == original_count, "Eraser input must remove a complete stroke")
    editor.undo_button.callback()
    assert(#editor.document:getPage().strokes == original_count + 1)
    editor.canvas.tool = "pen"
    editor:_turnPage(1)
    assert(editor.document.current_page == 2)
    editor:_turnPage(-1)
    assert(editor.document.current_page == 1)
    shot(editor, "editor")
    editor:_close()
    assert(engine.editor == nil)
    local saved = Document:new(editor.document.path)
    assert(saved:load() and #saved:getPage().strokes == original_count + 1)
    ui.layout[#ui.layout][1].callback()
    assert(ui.kindlespouse_tab == "Library" and not engine.gallery)
    ui.layout[#ui.layout][2].callback()
    assert(ui.kindlespouse_tab == "Notebook" and #engine.gallery.items == #titles)
    assert(Library.ensureDir("项目"))
    engine.gallery:_goTo("项目")
    assert(engine.gallery.folder == "项目" and #engine.gallery.items == 0)
    engine.gallery:_goTo("")
    assert(engine.gallery.folder == "" and #engine.gallery.items == #titles + 1)
end) end)
UIManager:scheduleIn(13, function() check(function()
    local data_file = assert(io.open(root .. "/native-vectors.json", "r"))
    local data = require("json").decode(data_file:read("*a"))
    data_file:close()
    local imported, counts = Import.document(engine.load, data, Library.abs("原生笔画导入测试.scribe"), { x = 0, y = 160, w = 1860, h = 2200 })
    assert(counts.strokes == 2 and counts.points == 6 and counts.pages == 2)
    local original = imported:getPage().strokes[1]
    assert(original.n == 3)
    imported:removeStrokes { original }
    assert(#imported:getPage().strokes == 1, "Imported original ink must be editable")
    assert(imported:undo())
    assert(#imported:getPage().strokes == 2)
    assert(imported:save())
    local reopened = Document:new(imported.path)
    assert(reopened:load() and reopened:pageCount() == 2 and reopened:getPage().strokes[1].n == 3)
    ui:reinit(ui.file_chooser.path)
    shot(ui, "saved")
    Screen:setRotationMode(1)
    ui:reinit(ui.file_chooser.path)
    shot(ui, "landscape")
    local private_file = io.open(root .. "/private-native-vectors.json", "r")
    if private_file then
        local original_data = require("json").decode(private_file:read("*a"))
        private_file:close()
        local copy, native_counts = Import.document(engine.load, original_data, Library.abs("离线旧笔记兼容测试.scribe"), { x = 0, y = 160, w = 1860, h = 2200 })
        assert(native_counts.pages == #original_data.pages and native_counts.strokes > 0)
        local original_stroke = assert(copy.pages[1].strokes[1])
        local original_points = original_stroke.n
        copy:removeStrokes { original_stroke }
        assert(copy:undo())
        assert(copy.pages[1].strokes[1] == original_stroke)
        copy:removeStrokes { original_stroke }
        local addition = Stroke:new { tool = "pen", width = 4 }
        addition:addPoint(200, 300, 1)
        addition:addPoint(300, 400, 0.7)
        copy:addStroke(addition)
        assert(copy:save())
        local persisted = Document:new(copy.path)
        assert(persisted:load() and persisted:pageCount() == native_counts.pages)
        assert(#persisted.pages[1].strokes == #original_data.pages[1].strokes)
        assert(persisted.pages[1].strokes[#persisted.pages[1].strokes].n == 2)
        print(string.format("Offline native Notebook edit passed: %d pages, %d original strokes, %d points in edited original stroke; source retained; edited copy saved and reopened.", native_counts.pages, native_counts.strokes, original_points))
    end
    print("Embedded Notebook acceptance passed: same-process gallery and editor, touch ink, undo/redo, atomic save and reopen, two-tab return, editable imported vectors, page count, portrait and landscape.")
    if not failed then UIManager:quit(0) end
end) end)
end)
