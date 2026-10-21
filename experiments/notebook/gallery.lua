return function(engine, companion, height)
    local Device = require("device")
    local UIManager = require("ui/uimanager")
    local Geom = require("ui/geometry")
    local VerticalGroup = require("ui/widget/verticalgroup")
    local ButtonTable = require("ui/widget/buttontable")
    local Shelf = require("shelf")
    local Screen = Device.screen
    local Library = engine.load("library")
    local Thumbnail = engine.load("thumbnail")
    engine.positions = engine.positions or {}
    assert(Library.ensureDir(""))
    local gallery = engine.load("gallery"):new {
        folder = engine.folder or "", query = engine.query,
        _layout = function() end, _drawThumbnails = function() end,
        on_open = function(name, folder, template) engine:open(name, folder, template, companion) end,
    }
    gallery.dimen = Geom:new { w = Screen:getWidth(), h = height }
    gallery.covers_fullscreen, gallery.ges_events = false, {}
    gallery._repaint = function() UIManager:setDirty(companion.ui, "ui") end
    gallery.onClose = function()
        companion.ui.kindlespouse_tab = "Library"
        companion.ui:reinit(companion.ui.file_chooser.path)
        UIManager:setDirty(companion.ui, "full")
        return true
    end
    gallery._layout = function(current)
        companion.ui.kindlespouse_notebook_query = current.query or ""
        if companion.ui.kindlespouse_search_label then
            companion.ui.kindlespouse_search_label:setText(current.query and current.query ~= "" and current.query or "搜索笔记本")
        end
        if current.shelf then current.shelf:onCloseWidget() end
        current:_freeWidgets()
        local filtered = {}
        for _, item in ipairs(current.items) do
            if not current.query or current.query == "" or item.name:find(current.query, 1, true) then filtered[#filtered + 1] = item end
        end
        current.items = filtered
        local actions
        if current.selection then
            local chosen = current:_selected()
            actions = {
                { text = "取消选择", callback = function() current:_endSelection() end },
                { text = "重命名", enabled = #chosen == 1, callback = function() current:_renameOne(chosen[1]) end },
                { text = "移动", callback = function() current:_moveSelection(chosen) end },
                { text = "删除", callback = function() current:_deleteMany(chosen) end },
            }
        else
            actions = {
                { text = "搜索", callback = function()
                    local dialog
                    dialog = require("ui/widget/inputdialog"):new { title = "搜索笔记本", input = current.query or "",
                        buttons = { {
                            { text = "取消", callback = function() UIManager:close(dialog) end },
                            { text = "搜索", callback = function()
                                current.query = dialog:getInputText(); UIManager:close(dialog); current:_rebuild()
                            end },
                        } } }
                    UIManager:show(dialog); dialog:onShowKeyboard()
                end },
                { text = "新建笔记", callback = function() current:_createNotebook() end },
                { text = current.folder == "" and "文件夹" or "返回上层", callback = function()
                    if current.folder == "" then current:_createFolder()
                    else current:_goTo(current.folder:match("^(.*)/[^/]+$") or "") end
                end },
                { text = "排序", callback = function() current:_chooseOrder() end },
            }
        end
        if not current.selection then
            companion.ui.kindlespouse_notebook_search = table.remove(actions, 1).callback
        end
        for _, action in ipairs(actions) do
            action.font_size = 12
            action.font_face = require("library").fonts.ui
            action.font_bold = false
        end
        local toolbar = ButtonTable:new { width = Screen:getWidth(), buttons = { actions } }
        local attempted, queue = {}, {}
        local key = table.concat({ current.folder, current.query or "", tostring(Screen:getWidth()), tostring(Screen:getHeight()) }, "\0")
        local view
        local function thumbnail()
            if view.closed then return end
            local filename = table.remove(queue, 1)
            if filename then
                pcall(Thumbnail.get, filename, view.cover_w, view.cover_h, 1860, 2480)
                view:refreshCards()
            end
            if #queue > 0 then UIManager:scheduleIn(0.2, thumbnail) end
        end
        view = Shelf:new { dimen = Geom:new { w = Screen:getWidth(), h = height - toolbar:getSize().h },
            items = current.items, show_parent = companion.ui,
            provider = function(item)
                local cached = not item.is_folder and Thumbnail.cached(item.path) or nil
                if not item.is_folder and not cached and not attempted[item.path] then
                    attempted[item.path] = true; queue[#queue + 1] = item.path
                    if #queue == 1 then UIManager:scheduleIn(0.2, thumbnail) end
                end
                return { title = item.name, file = cached, subtitle = item.is_folder and "文件夹" or "",
                    selected = current.selection and current.selection[item.path] ~= nil }
            end,
            on_open = function(item) current:_tapped(item) end,
            on_hold = function(item) current:_held(item) end,
            on_close = function()
                engine.positions[key] = view:getScrolledOffset()
                UIManager:unschedule(thumbnail)
            end,
        }
        view:setScrolledOffset(engine.positions[key])
        current.shelf = view
        companion.ui.cropping_widget = view
        current.holder[1] = VerticalGroup:new { align = "left", toolbar, view }
        companion.ui.title_bar:setSubTitle(string.format("%d 本笔记", #current.items))
    end
    gallery:_layout()
    engine.gallery = gallery
    return gallery
end
