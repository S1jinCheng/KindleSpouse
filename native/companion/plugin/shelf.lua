local Device = require("device")
local UIManager = require("ui/uimanager")
local Geom = require("ui/geometry")
local Font = require("ui/font")
local fonts = require("library").fonts
local InputContainer = require("ui/widget/container/inputcontainer")
local ScrollableContainer = require("ui/widget/container/scrollablecontainer")
local CenterContainer = require("ui/widget/container/centercontainer")
local FrameContainer = require("ui/widget/container/framecontainer")
local VerticalGroup = require("ui/widget/verticalgroup")
local VerticalSpan = require("ui/widget/verticalspan")
local TextBoxWidget = require("ui/widget/textboxwidget")
local TextWidget = require("ui/widget/textwidget")
local ImageWidget = require("ui/widget/imagewidget")
local GestureRange = require("ui/gesturerange")
local Screen = Device.screen
local Shelf = ScrollableContainer:extend { swipe_full_view = false, scroll_bar_width = 0 }
local Content = InputContainer:extend {}
local Card = InputContainer:extend {}

function Card:init()
    local data = self.data
    local picture
    if data.image then
        picture = ImageWidget:new { image = data.image,
            scale_factor = math.min(self.cover_w / data.image:getWidth(), self.cover_h / data.image:getHeight()) }
    elseif data.file then
        picture = ImageWidget:new { file = data.file, width = self.cover_w, height = self.cover_h }
    elseif self.list_view then
        picture = FrameContainer:new { padding = 0, margin = 0, bordersize = 1,
            CenterContainer:new { dimen = Geom:new { w = self.cover_w - 2, h = self.cover_h - 2 },
                require("ui/widget/iconwidget"):new { icon = "book.opened", width = Screen:scaleBySize(22), height = Screen:scaleBySize(22) } } }
    else
        picture = FrameContainer:new { width = self.cover_w, height = self.cover_h,
            padding = Screen:scaleBySize(12), margin = 0, bordersize = 1,
            CenterContainer:new { dimen = Geom:new { w = self.cover_w - Screen:scaleBySize(24), h = self.cover_h - Screen:scaleBySize(24) },
                TextBoxWidget:new { text = data.title, width = self.cover_w - Screen:scaleBySize(32),
                    face = Font:getFace(fonts.title, 16), alignment = "center" } } }
    end
    if data.image or data.file then
        picture = FrameContainer:new { padding = 0, margin = 0, bordersize = 1,
            CenterContainer:new { dimen = Geom:new { w = self.cover_w, h = self.cover_h }, picture } }
    end
    local text_width = self.list_view and self.width - self.cover_w - Screen:scaleBySize(54) or self.width
    self.caption = TextBoxWidget:new { text = (data.selected and "✓ " or "") .. data.title, width = text_width,
        face = Font:getFace(fonts.title, self.list_view and 12 or 13), alignment = "left", height = Screen:scaleBySize(self.list_view and 24 or 36), height_adjust = true,
        height_overflow_show_ellipsis = true }
    if self.list_view then
        local HorizontalGroup = require("ui/widget/horizontalgroup")
        local HorizontalSpan = require("ui/widget/horizontalspan")
        local Blitbuffer = require("ffi/blitbuffer")
        local progress
        if data.status == "new" or not data.status then
            progress = FrameContainer:new { padding = Screen:scaleBySize(1), margin = 0, bordersize = 0, background = Blitbuffer.COLOR_BLACK,
                TextWidget:new { text = "未读", face = Font:getFace(fonts.ui, 9), fgcolor = Blitbuffer.COLOR_WHITE } }
        else
            progress = HorizontalGroup:new { align = "center",
                require("ui/widget/progresswidget"):new { width = Screen:scaleBySize(50), height = Screen:scaleBySize(3),
                    percentage = math.max(0, math.min(1, data.progress or 0)), bordersize = 0, margin_v = 0, margin_h = 0 },
                HorizontalSpan:new { width = Screen:scaleBySize(6) },
                TextWidget:new { text = string.format("%d%% 已读", math.floor((data.progress or 0) * 100)), face = Font:getFace(fonts.ui, 9) },
            }
        end
        self.actions = require("ui/widget/button"):new { text = "⋮", width = Screen:scaleBySize(26), height = Screen:scaleBySize(38),
            bordersize = 0, padding = 0, text_font_face = fonts.ui, text_font_size = 15, text_font_bold = false,
            callback = function() self:onHold() end }
        self[1] = HorizontalGroup:new { align = "center",
            CenterContainer:new { dimen = Geom:new { w = self.cover_w, h = self.height - Screen:scaleBySize(8) }, picture },
            HorizontalSpan:new { width = Screen:scaleBySize(12) },
            VerticalGroup:new { align = "left", self.caption,
                TextWidget:new { text = data.subtitle or "", face = Font:getFace(fonts.ui, 10), max_width = text_width },
                VerticalSpan:new { width = Screen:scaleBySize(3) }, progress,
                TextWidget:new { text = data.format == "pdf" and "文档" or "图书", face = Font:getFace(fonts.ui, 9) },
            },
            HorizontalSpan:new { width = Screen:scaleBySize(16) },
            VerticalGroup:new { align = "center", self.actions,
                TextWidget:new { text = "✓", face = Font:getFace(fonts.ui, 10), fgcolor = Blitbuffer.COLOR_DARK_GRAY } },
        }
    else
        self[1] = VerticalGroup:new { align = "left",
            CenterContainer:new { dimen = Geom:new { w = self.width, h = self.cover_h }, picture },
            VerticalSpan:new { width = Screen:scaleBySize(8) },
            self.caption,
            TextWidget:new { text = data.subtitle or "", face = Font:getFace(fonts.ui, 10), max_width = text_width },
        }
    end
    self.dimen = Geom:new { w = self.width, h = self.height }
    self.ges_events = {
        Tap = { GestureRange:new { ges = "tap", range = self.dimen } },
        Hold = { GestureRange:new { ges = "hold", range = self.dimen } },
    }
end

function Card:paintTo(bb, x, y)
    InputContainer.paintTo(self, bb, x, y)
    if self.list_view then bb:paintRect(x, y + self.height - 1, self.width, 1, require("ffi/blitbuffer").COLOR_GRAY) end
end

function Card:onTap()
    self.owner.on_open(self.entry)
    return true
end

function Card:onHold()
    if self.owner.on_hold then self.owner.on_hold(self.entry) end
    return true
end

function Content:paintTo(bb, x, y)
    local owner = self.owner
    self.dimen.x, self.dimen.y = x, y
    local top = owner._scroll_offset_y or 0
    local first = math.max(1, math.floor(top / owner.row_h) * owner.columns + 1)
    local last = math.min(#owner.items, (math.ceil((top + owner.dimen.h) / owner.row_h) + 1) * owner.columns)
    for index, card in pairs(owner.cards) do
        if index < first or index > last then card:free(); owner.cards[index] = nil end
    end
    for index = #self, 1, -1 do self[index] = nil end
    for index = first, last do
        local card = owner.cards[index]
        if not card then
            local entry = owner.items[index]
            local data = owner.provider(entry, owner)
            card = Card:new { owner = owner, entry = entry, data = data, width = owner.card_w,
                height = owner.row_h, cover_w = owner.cover_w, cover_h = owner.cover_h, list_view = owner.list_view }
            owner.cards[index] = card
        end
        local column = (index - 1) % owner.columns
        local row = math.floor((index - 1) / owner.columns)
        card:paintTo(bb, x + owner.margin + column * (owner.card_w + owner.gap), y + row * owner.row_h)
        self[#self + 1] = card
    end
    owner.visible_first, owner.visible_last = first, last
    if owner.on_visible then owner:on_visible(first, last) end
end

function Content:free()
    for index, card in pairs(self.owner.cards) do card:free(); self.owner.cards[index] = nil end
    for index = #self, 1, -1 do self[index] = nil end
end

function Shelf:init()
    self.cards = {}
    self.margin, self.gap = Screen:scaleBySize(24), Screen:scaleBySize(24)
    self.columns = self.columns or (Screen:getWidth() > Screen:getHeight() and 4 or 3)
    if self.list_view then self.columns = 1 end
    self.card_w = math.floor((self.dimen.w - self.margin * 2 - self.gap * (self.columns - 1)) / self.columns)
    self.cover_w = math.floor(self.card_w * 0.86)
    self.cover_h = math.floor(self.cover_w * 1.43)
    self.row_h = self.cover_h + Screen:scaleBySize(78)
    if self.list_view then
        self.cover_w, self.cover_h, self.row_h = Screen:scaleBySize(46), Screen:scaleBySize(68), Screen:scaleBySize(82)
    end
    self[1] = Content:new { owner = self, dimen = Geom:new { w = self.dimen.w,
        h = math.max(self.dimen.h, math.ceil(#self.items / self.columns) * self.row_h) } }
    ScrollableContainer.init(self)
end

function Shelf:initState()
    ScrollableContainer.initState(self)
    if self._v_scroll_bar then self._v_scroll_bar:free(); self._v_scroll_bar = nil end
    if self._h_scroll_bar then self._h_scroll_bar:free(); self._h_scroll_bar = nil end
end

function Shelf:refreshCards()
    if self.closed then return end
    self[1]:free()
    UIManager:setDirty(self.show_parent, "ui")
end

function Shelf:setScrolledOffset(offset)
    if not offset then return end
    self._scroll_offset_x = 0
    self._scroll_offset_y = math.max(0, math.min(offset.y or 0, self[1].dimen.h - self.dimen.h))
end

function Shelf:onCloseWidget()
    if self.closed then return end
    self.closed = true
    if self.on_close then self:on_close() end
    self[1]:free()
    ScrollableContainer.onCloseWidget(self)
end

function Shelf:free()
    self:onCloseWidget()
end

function Shelf.library(ui, height)
    local manager = require("bookinfomanager")
    local attempted, pending = {}, {}
    local settings = require("library").settings()
    local key_parts = { ui.file_chooser.path, tostring(Screen:getWidth()), tostring(Screen:getHeight()) }
    for _, name in ipairs({ "query", "shelf", "format", "author", "source", "collection", "sort", "view" }) do
        key_parts[#key_parts + 1] = settings[name]
    end
    local key = table.concat(key_parts, "\0")
    ui.kindlespouse_positions = ui.kindlespouse_positions or {}
    local shelf
    shelf = Shelf:new { dimen = Geom:new { w = Screen:getWidth(), h = height },
        list_view = settings.view == "list",
        items = ui.file_chooser.item_table, show_parent = ui,
        provider = function(item, view)
            local info = manager:getBookInfo(item.path, true)
            if not info or not info.cover_fetched or info.has_cover and manager.isCachedCoverInvalid(info,
                { max_cover_w = view.cover_w, max_cover_h = view.cover_h }) then pending[item.path] = true end
            local data = item.kindlespouse
            return { image = info and info.cover_bb, title = info and info.title or data.title,
                subtitle = info and info.authors or (data.author ~= "未提供作者" and data.author or ""),
                status = data.status, progress = data.progress, format = data.format }
        end,
        on_open = function(item) ui.file_chooser:onFileSelect(item) end,
        on_hold = function(item) ui.file_chooser:onFileHold(item) end,
    }
    local function collect()
        if shelf.closed then return end
        manager:collectSubprocesses()
        if ui.kindlespouse_recent then ui.kindlespouse_recent:updateCover() end
        shelf:refreshCards()
        if manager:isExtractingInBackground() then UIManager:scheduleIn(1, collect) end
    end
    local function extract()
        shelf.queued = false
        if shelf.closed then return end
        local files = {}
        for filename in pairs(pending) do
            if not attempted[filename] then
                attempted[filename] = true
                files[#files + 1] = { filepath = filename, cover_specs = { max_cover_w = shelf.cover_w, max_cover_h = shelf.cover_h } }
            end
            pending[filename] = nil
        end
        if #files > 0 then manager:extractInBackground(files); UIManager:scheduleIn(1, collect) end
    end
    shelf.on_visible = function()
        if next(pending) and not shelf.queued then shelf.queued = true; UIManager:scheduleIn(0.2, extract) end
    end
    shelf.on_close = function()
        ui.kindlespouse_positions[key] = shelf:getScrolledOffset()
        UIManager:unschedule(extract)
        UIManager:unschedule(collect)
        manager:terminateBackgroundJobs()
        manager:collectSubprocesses()
    end
    shelf:setScrolledOffset(ui.kindlespouse_positions[key])
    return shelf
end

return Shelf
