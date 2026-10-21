local Widget = require("ui/widget/widget")
local Geom = require("ui/geometry")
local Blitbuffer = require("ffi/blitbuffer")
local Font = require("ui/font")
local TextBox = require("ui/widget/textboxwidget")
local TextWidget = require("ui/widget/textwidget")
local Screen = require("device").screen
local M = {}
local cached_cover, cover_key, cached_avatar, avatar_key

local function profile()
    local file = io.open("/mnt/us/kindlespouse/sleep-profile.json", "rb")
    if not file then return { enabled = true, displayName = "Reader", avatar = "R" } end
    local bytes = file:read(4097); file:close()
    local ok, data = pcall(require("json").decode, bytes)
    if ok and type(data) == "table" and #bytes <= 4096 then return data end
    return { enabled = true, displayName = "Reader", avatar = "R" }
end

local function filekey(filename)
    local attributes = filename and require("libs/libkoreader-lfs").attributes(filename)
    return tostring(filename) .. ":" .. tostring(attributes and attributes.size) .. ":" .. tostring(attributes and attributes.modification)
end

function M.prepare(ui, data, person)
    data, person = data or {}, person or profile()
    local w, h = Screen:getWidth(), Screen:getHeight()
    local filename = ui and ui.document and ui.document.file or data.cover_path
    local key = filekey(filename) .. ":" .. w .. ":" .. h
    if key ~= cover_key then
        if cached_cover then cached_cover:free(); cached_cover = nil end
        cover_key = nil
        local function image(doc)
            if doc and doc.getCoverPageImage then
                local ok, value = pcall(doc.getCoverPageImage, doc)
                if ok then return value end
            end
        end
        local cover = image(ui and ui.document)
        if not cover and data.cover_path then
            local doc = require("document/documentregistry"):openDocument(data.cover_path)
            if doc then cover = image(doc); doc:close() end
        end
        if cover then
            local ratio = math.min(w * 0.49 / cover:getWidth(), h * 0.48 / cover:getHeight())
            local cw, ch = math.max(1, math.floor(cover:getWidth() * ratio)), math.max(1, math.floor(cover:getHeight() * ratio))
            local scaled = require("ui/renderimage"):scaleBlitBuffer(cover, cw, ch, true)
            cached_cover = Blitbuffer.new(cw, ch, Blitbuffer.TYPE_BB8)
            cached_cover:blitFrom(scaled, 0, 0, 0, 0, cw, ch)
            scaled:free()
        end
        cover_key = key
    end
    local avatar_path = person.avatarPath
    if not avatar_path and type(person.avatarHash) == "string" and #person.avatarHash == 64 and person.avatarHash:match("^[a-f0-9]+$") then
        avatar_path = "/mnt/us/kindlespouse/avatars/" .. person.avatarHash .. ".png"
    end
    key = filekey(avatar_path) .. ":" .. w
    if key ~= avatar_key then
        if cached_avatar then cached_avatar:free(); cached_avatar = nil end
        avatar_key = nil
        if avatar_path then
            local ok, image = pcall(function() return require("ui/renderimage"):renderImageFile(avatar_path) end)
            if ok and image then
                local size = math.floor(w * 0.088)
                local scaled = require("ui/renderimage"):scaleBlitBuffer(image, size, size, true)
                cached_avatar = Blitbuffer.new(size, size, Blitbuffer.TYPE_BB8)
                cached_avatar:paintRect(0, 0, size, size, Blitbuffer.COLOR_WHITE)
                local radius = size / 2
                for row = 0, size - 1 do
                    local half = math.sqrt(math.max(0, radius * radius - (row + 0.5 - radius)^2))
                    local start, finish = math.ceil(radius - half), math.floor(radius + half)
                    cached_avatar:blitFrom(scaled, start, row, start, row, math.max(0, finish - start), 1)
                end
                scaled:free()
            end
        end
        avatar_key = key
    end
end

function M.build(ui, state, data, person, stats)
    person = person or profile()
    data = data or {}
    if not stats then
        local ok, result = pcall(function()
            if ui and ui.statistics then ui.statistics:insertDB() end
            return require("css_stats").getAllStats()
        end)
        stats = ok and result or nil
    end
    local w, h = Screen:getWidth(), Screen:getHeight()
    local margin, width = math.floor(w * 0.058), math.floor(w * 0.884)
    local Cover = Widget:extend{}
    local children = {}
    local function text(value, x, y, size, text_width, align, font, max_height)
        local widget = TextBox:new { text = tostring(value), width = text_width or width,
            height = max_height, height_overflow_show_ellipsis = true, line_height = 0.12,
            face = Font:getFace(font or "cfont", size / Screen:scaleBySize(1)), alignment = align or "left" }
        children[#children + 1] = { widget = widget, x = math.floor(x), y = math.floor(y) }
        return widget
    end
    text("C U R R E N T L Y   R E A D I N G", margin, h * 0.038, w * 0.022)
    M.prepare(ui, data, person)
    local cover = cached_cover and cached_cover:copy()
    local photo = cached_avatar and cached_avatar:copy()
    local cover_w, cover_h, cover_x, cover_y
    if cover then
        cover_w, cover_h = cover:getWidth(), cover:getHeight()
        cover_x, cover_y = math.floor((w - cover_w) / 2), math.floor(h * 0.08 + (h * 0.48 - cover_h) / 2)
    else
        cover_w, cover_h, cover_x, cover_y = math.floor(w * 0.44), math.floor(h * 0.46), math.floor(w * 0.28), math.floor(h * 0.09)
        text(data.title or "Your next chapter", cover_x + w * 0.04, cover_y + cover_h * 0.3, w * 0.045, cover_w - w * 0.08, "center", "NotoSerif-Regular.ttf", cover_h * 0.5)
        text("PERSONAL LIBRARY", cover_x + w * 0.04, cover_y + cover_h * 0.86, w * 0.016, cover_w - w * 0.08, "center")
    end
    local title_size, title = w * 0.085, data.title or "Your next chapter"
    local title_widget
    repeat
        title_widget = TextBox:new { text = title, width = width, face = Font:getFace("NotoSerif-Regular.ttf", title_size / Screen:scaleBySize(1)), alignment = "center", line_height = 0.08 }
        if title_widget:getSize().h <= h * 0.104 or title_size <= w * 0.041 then break end
        title_widget:free(); title_size = title_size * 0.9
    until false
    title_widget:free()
    text(title, margin, h * 0.585, title_size, width, "center", "NotoSerif-Regular.ttf", h * 0.104)
    text(data.authors or "", margin, h * 0.678, w * 0.025, width, "center", nil, h * 0.036)
    local progress = tonumber(data.progress) or (tonumber(data.page) or 0) / math.max(1, tonumber(data.doc_pages) or 1)
    progress = math.max(0, math.min(1, progress))
    text("R E A D I N G   P R O G R E S S", margin, h * 0.736, w * 0.021, width * 0.7)
    text(string.format("%d%%", math.floor(progress * 100 + 0.5)), margin + width * 0.7, h * 0.72, w * 0.054, width * 0.3, "right", "NotoSerif-Regular.ttf")
    if not photo then
        local avatar = TextWidget:new { text = person.avatar or "R", face = Font:getFace("NotoSerif-Regular.ttf", w * 0.039 / Screen:scaleBySize(1)), padding = 0, max_width = w * 0.082 }
        children[#children + 1] = { widget = avatar, x = math.floor(margin + w * 0.044 - avatar:getSize().w / 2), y = math.floor(h * 0.86 - avatar:getSize().h / 2) }
    end
    text(person.displayName or "Reader", margin + w * 0.12, h * 0.836, w * 0.042, width - w * 0.12, "left", "NotoSerif-Regular.ttf", h * 0.055)
    text("R E A D I N G   T O D A Y", margin, h * 0.907, w * 0.019, width * 0.48)
    text("R E A D I N G   S T R E A K", margin + width * 0.64, h * 0.907, w * 0.019, width * 0.36)
    text(stats and string.format("%d min", math.floor((stats.duration or 0) / 60)) or "—", margin, h * 0.928, w * 0.065, width * 0.48, "left", "NotoSerif-Regular.ttf", h * 0.065)
    text(stats and string.format("%d days", stats.streak or 0) or "—", margin + width * 0.64, h * 0.928, w * 0.065, width * 0.36, "left", "NotoSerif-Regular.ttf", h * 0.065)
    local widget = Cover:new { dimen = Geom:new { w = w, h = h } }
    function widget:paintTo(bb, x, y)
        bb:paintRect(x, y, w, h, Blitbuffer.COLOR_WHITE)
        if cover then bb:blitFrom(cover, x + cover_x, y + cover_y, 0, 0, cover_w, cover_h)
        else
            bb:paintRect(x + cover_x, y + cover_y, cover_w, cover_h, Blitbuffer.COLOR_GRAY)
            bb:paintRect(x + cover_x + 2, y + cover_y + 2, cover_w - 4, cover_h - 4, Blitbuffer.COLOR_WHITE)
            bb:paintRect(x + cover_x + math.floor(w * 0.012), y + cover_y, 2, cover_h, Blitbuffer.COLOR_LIGHT_GRAY)
        end
        bb:paintRect(x + margin, y + math.floor(h * 0.765), width, math.max(2, math.floor(h * 0.009)), Blitbuffer.COLOR_LIGHT_GRAY)
        bb:paintRect(x + margin, y + math.floor(h * 0.765), math.floor(width * progress), math.max(2, math.floor(h * 0.009)), Blitbuffer.COLOR_BLACK)
        bb:paintRect(x + margin, y + math.floor(h * 0.805), width, 2, Blitbuffer.COLOR_GRAY)
        if photo then bb:blitFrom(photo, x + margin, y + math.floor(h * 0.86 - photo:getHeight() / 2), 0, 0, photo:getWidth(), photo:getHeight())
        else bb:paintCircle(x + margin + math.floor(w * 0.044), y + math.floor(h * 0.86), math.floor(w * 0.044), Blitbuffer.COLOR_LIGHT_GRAY) end
        bb:paintRect(x + math.floor(w * 0.5), y + math.floor(h * 0.904), 2, math.floor(h * 0.075), Blitbuffer.COLOR_GRAY)
        for _, child in ipairs(children) do child.widget:paintTo(bb, x + child.x, y + child.y) end
    end
    function widget:free()
        if cover then cover:free(); cover = nil end
        if photo then photo:free(); photo = nil end
        for _, child in ipairs(children) do child.widget:free() end
        children = {}
    end
    function widget:onCloseWidget() self:free() end
    return widget
end

function M.wrap(fallback)
    return function(ui, state, data)
        if not profile().enabled then return fallback(ui, state, data) end
        if not data and ui then data = require("css_infobox_bookdata").collectBookData(ui, state) end
        return M.build(ui, state, data)
    end
end
return M
