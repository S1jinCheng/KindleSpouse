local Device = require("device")
local FileChooser = require("ui/widget/filechooser")
local UIManager = require("ui/uimanager")
local lfs = require("libs/libkoreader-lfs")
local Screen = Device.screen
local Home = {}
local Library = require("library")

function Home.enabled()
    return G_reader_settings:readSetting("kindlespouse_home") ~= false
end

function Home.navigationHeight()
    return Screen:scaleBySize(40)
end

function Home.books(chooser, root)
    local files, visited = {}, {}
    local collate = chooser:getCollate()
    local history = {}
    for _, item in ipairs(require("readhistory").hist) do history[item.file] = item.time end
    local function visit(directory)
        if visited[directory] then return end
        visited[directory] = true
        local ok, iterator, state = pcall(lfs.dir, directory)
        if not ok then return end
        for name in iterator, state do
            if name:sub(1, 1) ~= "." and not name:match("%.sdr$") then
                local filename = directory .. "/" .. name
                local attr = lfs.symlinkattributes(filename)
                if attr and attr.mode == "directory" and chooser:show_dir(name) then
                    visit(filename)
                elseif attr and attr.mode == "file" and require("document/documentregistry"):hasProvider(filename) then
                    files[#files + 1] = Library.record(chooser.ui, chooser:getListItem(directory, name, filename, attr, collate), root, history)
                end
            end
        end
    end
    visit(root)
    chooser.ui.kindlespouse_catalog = files
    return Library.apply(files, Library.settings())
end

local original_init = FileChooser.init
function FileChooser:init()
    if self.ui and self.ui.kindlespouse_home and Home.enabled() then
        self.height = Screen:getHeight() - Home.navigationHeight()
        self.genItemTableFromPath = function(chooser, root) return Home.books(chooser, root) end
    end
    original_init(self)
end

function Home.returnToKindle(companion)
    if not Device:isKindle() then
        companion:notify("Scribe notebooks are available on the Kindle Scribe.")
        return
    end
    companion.ui:onClose()
    UIManager:quit()
end

function Home.notebook(companion, height)
    local CenterContainer = require("ui/widget/container/centercontainer")
    local VerticalGroup = require("ui/widget/verticalgroup")
    local VerticalSpan = require("ui/widget/verticalspan")
    local TextBoxWidget = require("ui/widget/textboxwidget")
    local Button = require("ui/widget/button")
    local Font = require("ui/font")
    local width = Screen:getWidth() - Screen:scaleBySize(64)
    return CenterContainer:new {
        dimen = require("ui/geometry"):new { w = Screen:getWidth(), h = height },
        VerticalGroup:new {
            align = "center",
            TextBoxWidget:new { text = "Scribe 手写笔记本", width = width,
                alignment = "center", face = Font:getFace(Library.fonts.title, 28) },
            VerticalSpan:new { width = Screen:scaleBySize(24) },
            TextBoxWidget:new {
                text = "手写笔记本由 Kindle 系统打开和编辑。\n返回 Kindle 后，点击底部的“笔记本”继续书写。",
                width = width, alignment = "center", face = Font:getFace(Library.fonts.ui, 20),
            },
            VerticalSpan:new { width = Screen:scaleBySize(32) },
            Button:new { text = "返回 Kindle，打开手写笔记本", width = width,
                callback = function() Home.returnToKindle(companion) end },
        },
    }
end

function Home.lastBook()
    local registry = require("document/documentregistry")
    local latest, when
    for _, item in ipairs(require("readhistory").hist) do
        if type(item.file) == "string" and lfs.attributes(item.file, "mode") == "file" and registry:hasProvider(item.file) then
            local time = tonumber(item.time) or 0
            if not latest or time > when then latest, when = item.file, time end
        end
    end
    local previous = G_reader_settings:readSetting("lastfile")
    if not latest and type(previous) == "string" and lfs.attributes(previous, "mode") == "file" and registry:hasProvider(previous) then latest = previous end
    return latest
end

function Home.openRecent(companion, filename)
    if not filename then companion:notify("还没有阅读记录，请先打开一本书。"); return end
    if lfs.attributes(filename, "mode") ~= "file" then
        companion:notify("上次阅读的图书已移动或删除。")
        companion.ui:reinit(companion.ui.file_chooser.path)
        return
    end
    require("apps/reader/readerui"):showReader(filename)
end

function Home.recentButton(companion, width)
    local Geom = require("ui/geometry")
    local InputContainer = require("ui/widget/container/inputcontainer")
    local file = Home.lastBook()
    local cover_w, cover_h = Screen:scaleBySize(44), Screen:scaleBySize(64)
    local protrude = cover_h - Home.navigationHeight()
    local info = file and require("bookinfomanager"):getBookInfo(file, true) or nil
    local picture
    if info and info.cover_bb then
        local bb = info.cover_bb
        picture = require("ui/widget/imagewidget"):new { image = bb, scale_factor = math.min(cover_w / bb:getWidth(), cover_h / bb:getHeight()) }
    else
        picture = require("ui/widget/iconwidget"):new { icon = "book.opened", width = cover_w - 12, height = cover_h - 12 }
    end
    local title = info and info.title or file and file:match("([^/]+)$") or "继续阅读"
    local button = InputContainer:new { file = file, title = title, cover_loaded = info and info.cover_bb ~= nil,
        dimen = Geom:new { w = width, h = cover_h },
        require("ui/widget/container/centercontainer"):new { dimen = Geom:new { w = width, h = cover_h },
            require("ui/widget/container/framecontainer"):new { padding = 0, margin = 0, bordersize = 1,
                require("ui/widget/container/centercontainer"):new { dimen = Geom:new { w = cover_w - 2, h = cover_h - 2 }, picture } } } }
    button.getSize = function() return Geom:new { w = width, h = Home.navigationHeight() } end
    button.paintTo = function(widget, bb, x, y)
        widget.dimen.x, widget.dimen.y = x, y - protrude
        widget[1]:paintTo(bb, x, y - protrude)
    end
    button.callback = function() Home.openRecent(companion, file) end
    button.updateCover = function(widget)
        if not file or widget.cover_loaded then return end
        local cached = require("bookinfomanager"):getBookInfo(file, true)
        if not cached or not cached.cover_bb then return end
        local bb = cached.cover_bb
        widget[1]:free()
        widget[1] = require("ui/widget/container/centercontainer"):new { dimen = Geom:new { w = width, h = cover_h },
            require("ui/widget/container/framecontainer"):new { padding = 0, margin = 0, bordersize = 1,
                require("ui/widget/container/centercontainer"):new { dimen = Geom:new { w = cover_w - 2, h = cover_h - 2 },
                    require("ui/widget/imagewidget"):new { image = bb, scale_factor = math.min((cover_w - 2) / bb:getWidth(), (cover_h - 2) / bb:getHeight()) } } } }
        widget.cover_loaded, widget.title = true, cached.title or widget.title
    end
    button.ges_events = {
        Recent = { require("ui/gesturerange"):new { ges = "tap", range = button.dimen } },
        RecentTitle = { require("ui/gesturerange"):new { ges = "hold", range = button.dimen } },
    }
    button.onRecent = function() button.callback(); return true end
    button.onRecentTitle = function(widget) companion:notify(widget.title); return true end
    return button
end

function Home.layout(ui, companion)
    local VerticalGroup = require("ui/widget/verticalgroup")
    local HorizontalGroup = require("ui/widget/horizontalgroup")
    local FrameContainer = require("ui/widget/container/framecontainer")
    local LeftContainer = require("ui/widget/container/leftcontainer")
    local Button = require("ui/widget/button")
    local Blitbuffer = require("ffi/blitbuffer")
    local center_width = Screen:scaleBySize(88)
    local side_width = math.floor((Screen:getWidth() - center_width) / 2)
    local selected = ui.kindlespouse_tab or "Library"
    if ui.kindlespouse_shelf then ui.kindlespouse_shelf:onCloseWidget(); ui.kindlespouse_shelf = nil end
    if ui.kindlespouse_recent then ui.kindlespouse_recent:free() end
    if ui.kindlespouse_header then ui.kindlespouse_header:free() end
    ui.cropping_widget = nil
    local header = Library.header(ui, companion)
    ui.kindlespouse_header = header
    local body = ui[1]
    local focus = {}
    if selected == "Notebook" then
        local height = Screen:getHeight() - Home.navigationHeight() - header:getSize().h
        body = VerticalGroup:new { align = "left", header, Home.notebook(companion, height) }
        focus = {}
    else
        local toolbar = Library.toolbar(ui)
        local height = Screen:getHeight() - Home.navigationHeight() - header:getSize().h - toolbar:getSize().h
        ui.kindlespouse_shelf = require("shelf").library(ui, height)
        ui.cropping_widget = ui.kindlespouse_shelf
        body = VerticalGroup:new { align = "left", header, toolbar, ui.kindlespouse_shelf }
    end
    local navigation = HorizontalGroup:new { align = "center" }
    for index, tab in ipairs({ "Library", "Notebook" }) do
        navigation[index == 1 and 1 or 3] = Button:new {
            text = tab == "Notebook" and "Notebooks" or tab, width = index == 1 and side_width or Screen:getWidth() - side_width - center_width,
            height = Home.navigationHeight(), bordersize = 0, padding = 0,
            text_font_face = Library.fonts.ui, text_font_size = 12, text_font_bold = false, radius = 0,
            background = Blitbuffer.COLOR_WHITE,
            show_parent = ui,
            callback = function()
                if ui.kindlespouse_tab == tab then return end
                ui.kindlespouse_tab = tab
                ui:reinit(ui.file_chooser.path)
                UIManager:setDirty(ui, "ui")
            end,
        }
    end
    navigation[2] = Home.recentButton(companion, center_width)
    ui.kindlespouse_recent = navigation[2]
    for index, tab in ipairs({ "Library", "Notebook" }) do
        local button = navigation[index == 1 and 1 or 3]
        local original_paint = button.paintTo
        button.paintTo = function(widget, bb, x, y)
            original_paint(widget, bb, x, y)
            if selected == tab then
                local label = widget.label_widget:getSize()
                bb:paintRect(x + math.floor((widget.width - label.w) / 2),
                    y + math.floor((widget.height + label.h) / 2) + Screen:scaleBySize(3), label.w, 2, Blitbuffer.COLOR_BLACK)
            end
        end
    end
    local original_paint = navigation.paintTo
    navigation.paintTo = function(widget, bb, x, y)
        original_paint(widget, bb, x, y)
        local gap = Screen:scaleBySize(46)
        local left = math.floor((Screen:getWidth() - gap) / 2)
        bb:paintRect(x, y, left, 1, Blitbuffer.COLOR_GRAY)
        bb:paintRect(x + left + gap, y, Screen:getWidth() - left - gap, 1, Blitbuffer.COLOR_GRAY)
    end
    ui[1] = FrameContainer:new {
        padding = 0, margin = 0, bordersize = 0, background = Blitbuffer.COLOR_WHITE,
        VerticalGroup:new { align = "left",
            LeftContainer:new { dimen = require("ui/geometry"):new { w = Screen:getWidth(), h = Screen:getHeight() - Home.navigationHeight() }, body },
            navigation },
    }
    local original_propagate = ui[1].propagateEvent
    ui[1].propagateEvent = function(widget, event)
        local gesture = event.handler == "onGesture" and event.args and event.args[1]
        if gesture and gesture.pos and (gesture.ges == "tap" or gesture.ges == "hold")
            and gesture.pos:intersectWith(ui.kindlespouse_recent.dimen) and ui.kindlespouse_recent:handleEvent(event) then return true end
        return original_propagate(widget, event)
    end
    ui.layout = {}
    for _, row in ipairs(focus or {}) do ui.layout[#ui.layout + 1] = row end
    ui.layout[#ui.layout + 1] = { navigation[1], navigation[3] }
    ui.title_bar:setTitle(selected)
    ui.title_bar:setSubTitle(selected == "Library" and Home.count(ui) or "Kindle Scribe")
    ui:registerKeyEvents()
end

function Home.install(companion)
    local ui = companion.ui
    if Home.enabled() then Home.prepareStart() end
    if ui.document then return end
    ui.kindlespouse_home = true
    ui.kindlespouse_tab = "Library"
    local original_layout = ui.setupLayout
    ui.setupLayout = function(manager)
        if manager.file_chooser and manager.file_chooser.onCloseWidget then manager.file_chooser:onCloseWidget() end
        if manager.coverbrowser and (Home.enabled() or G_reader_settings:readSetting("kindlespouse_home_saved")) then
            if Home.enabled() then Home.prepare(manager) end
            local chooser = manager.file_chooser
            manager.file_chooser = nil
            local mode = G_reader_settings:readSetting("kindlespouse_home_previous_mode") or nil
            if Home.enabled() then mode = nil end
            manager.coverbrowser:setDisplayMode(mode)
            manager.file_chooser = chooser
        end
        if Home.enabled() then manager.root_path = Home.root(manager) end
        original_layout(manager)
        if Home.enabled() then Home.layout(manager, companion) end
    end
    local original_home = ui.onHome
    ui.onHome = function(manager)
        if not Home.enabled() then return original_home(manager) end
        manager.kindlespouse_tab = "Library"
        manager:reinit(Home.root(manager))
        UIManager:setDirty(manager, "ui")
        return true
    end
    local original_path = ui.updateTitleBarPath
    ui.updateTitleBarPath = function(manager, path)
        if not Home.enabled() then return original_path(manager, path) end
        manager.title_bar:setSubTitle(manager.kindlespouse_tab == "Notebook" and "Kindle Scribe" or Home.count(manager))
    end
    ui.onPathChanged = ui.updateTitleBarPath
    ui:registerPostInitCallback(function()
        if Home.enabled() then
            Home.prepare(ui)
            ui:reinit(Home.root(ui))
        end
    end)
end

function Home.root(ui)
    local folder = G_reader_settings:readSetting("home_dir")
    if folder and lfs.attributes(folder, "mode") == "directory" and folder ~= "/mnt/us" then return folder end
    if lfs.attributes("/mnt/us/documents", "mode") == "directory" then return "/mnt/us/documents" end
    return ui.root_path
end

function Home.prepare(ui)
    Home.prepareStart()
    if not G_reader_settings:readSetting("kindlespouse_home_saved") then
        if ui.coverbrowser then
            G_reader_settings:saveSetting("kindlespouse_home_previous_mode", require("bookinfomanager"):getSetting("filemanager_display_mode") or false)
        end
        G_reader_settings:saveSetting("kindlespouse_home_saved", true)
    end
end

function Home.count(ui)
    local total, visible = #(ui.kindlespouse_catalog or {}), #ui.file_chooser.item_table
    return visible == total and string.format("%d 本图书", total) or string.format("%d / %d 本图书 · 已筛选", visible, total)
end

function Home.prepareStart()
    Library.prepareFonts()
    if not G_reader_settings:isTrue("kindlespouse_native_library") then
        local settings = Library.settings()
        settings.sort = "recent"
        settings.view = "list"
        Library.save(settings)
        G_reader_settings:saveSetting("kindlespouse_native_library", true)
    end
    if not G_reader_settings:readSetting("kindlespouse_home_start_saved") then
        G_reader_settings:saveSetting("kindlespouse_home_previous_start", G_reader_settings:readSetting("start_with") or false)
        G_reader_settings:saveSetting("kindlespouse_home_start_saved", true)
    end
    G_reader_settings:saveSetting("start_with", "filemanager")
end

function Home.toggle(companion)
    local ui = companion.ui
    if ui.kindlespouse_recent then ui.kindlespouse_recent:free(); ui.kindlespouse_recent = nil end
    if ui.kindlespouse_shelf then ui.kindlespouse_shelf:onCloseWidget(); ui.kindlespouse_shelf = nil end
    ui.cropping_widget = nil
    local enabled = not Home.enabled()
    G_reader_settings:saveSetting("kindlespouse_home", enabled)
    if enabled then
        Home.prepare(ui)
    elseif G_reader_settings:readSetting("kindlespouse_home_saved") then
        G_reader_settings:saveSetting("start_with", G_reader_settings:readSetting("kindlespouse_home_previous_start") or nil)
    end
    ui.kindlespouse_tab = "Library"
    ui:reinit(Home.root(ui))
    UIManager:setDirty(ui, "ui")
end

return Home
