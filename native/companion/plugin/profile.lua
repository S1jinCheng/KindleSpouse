local Device = require("device")
local UIManager = require("ui/uimanager")
local Font = require("ui/font")
local Geom = require("ui/geometry")
local InputContainer = require("ui/widget/container/inputcontainer")
local lfs = require("libs/libkoreader-lfs")
local json = require("json")
local Screen = Device.screen
local Profile = {}
local Panel = InputContainer:extend { covers_fullscreen = true }
local Calendar = InputContainer:extend {}
local stages = {
    checking_pairing = "检查网盘连接", checking_local_profile = "连接 KindleSpouse",
    receiving_local_profile = "通过局域网同步资料", receiving_profile = "通过网盘同步资料",
    syncing_titles = "同步笔记本名称", checking_inbox = "检查新书", checking_book_folder = "检查书籍目录",
    receiving_folder_books = "接收网盘图书", receiving_books = "接收图书", saving_receipts = "确认接收结果",
    scanning_notes = "整理笔记和标注", backing_up_catalog = "整理书库和阅读记录", checking_cloud = "检查网盘备份",
    uploading_notes = "上传笔记", packing_notes = "打包笔记", uploading_bundles = "上传备份",
    publishing = "校验同步结果", receiving_annotations = "接收标注修改",
}

function Profile.read(directory, name)
    local file = io.open(directory .. "/" .. name, "rb")
    if not file then return end
    local bytes = file:read(65537)
    file:close()
    if not bytes or #bytes > 65536 then return end
    local ok, data = pcall(json.decode, bytes)
    if ok and type(data) == "table" then return data end
end

function Profile.snapshot(companion)
    local directory = companion.directory or "/mnt/us/kindlespouse"
    local person = Profile.read(directory, "sleep-profile.json") or {}
    local config = Profile.read(directory, "config.json")
    local progress = companion.status and companion:status() or Profile.read(directory, "progress.json") or { state = "idle" }
    local receipt = Profile.read(directory, "profile-receipt.json")
    local local_receipt = Profile.read(directory, "lan-profile-receipt.json")
    local route = "网盘"
    if local_receipt and (not receipt or tostring(local_receipt.receivedAt or "") > tostring(receipt.receivedAt or "")) then
        receipt, route = local_receipt, "局域网"
    end
    local avatar
    if type(person.avatarHash) == "string" and #person.avatarHash == 64 and person.avatarHash:match("^[a-f0-9]+$") then
        local filename = directory .. "/avatars/" .. person.avatarHash .. ".png"
        if lfs.attributes(filename, "mode") == "file" then avatar = filename end
    end
    local state = companion.launch_pending and "running" or progress.state or "idle"
    local labels = { idle = "尚未开始同步", running = "正在同步", completed = "同步完成", failed = "同步失败", paused = "已暂停", pausing = "正在暂停" }
    local detail = stages[progress.stage] or (state == "running" and "正在连接，请稍候" or "")
    if state == "completed" then
        if progress.profileOnly then detail = "个人资料已更新"
        else detail = string.format("接收 %d 本图书 · 备份 %d 个文件", tonumber(progress.received) or 0, tonumber(progress.files) or 0) end
    elseif state == "failed" then detail = "请检查 Wi-Fi 和网盘授权，然后重试。" end
    if state == "running" and tonumber(progress.total) and progress.total > 0 then
        detail = detail .. string.format(" · %d/%d", tonumber(progress.done) or 0, progress.total)
    end
    local synced = tonumber(progress.completedAt) or (G_reader_settings and tonumber(G_reader_settings:readSetting("kindlespouse_last_sync")))
    return { paired = config ~= nil, name = type(person.displayName) == "string" and person.displayName or "尚未同步个人资料",
        initials = type(person.avatar) == "string" and person.avatar or "K", avatar = avatar,
        device = config and config.name or "Kindle", clouds = type(person.clouds) == "table" and person.clouds or nil,
        reading = type(person.reading) == "table" and type(person.reading.days) == "table" and person.reading or nil,
        state = state, status = labels[state] or "等待同步", detail = detail, route = route,
        profile_received = receipt and receipt.receivedAt or nil,
        last_sync = synced and os.date("%Y-%m-%d %H:%M", synced) or nil }
end

function Profile.duration(seconds)
    local minutes = math.floor((tonumber(seconds) or 0) / 60)
    if minutes == 0 then return (tonumber(seconds) or 0) > 0 and "不足 1 分钟" or "0 分钟" end
    if minutes < 60 then return minutes .. " 分钟" end
    return math.floor(minutes / 60) .. " 小时" .. (minutes % 60 > 0 and " " .. minutes % 60 .. " 分钟" or "")
end

function Calendar:init()
    local TextWidget = require("ui/widget/textwidget")
    local function label(value, size)
        return TextWidget:new { text = value, face = Font:getFace(require("library").fonts.ui, size) }
    end
    self.labels, self.cells = {}, {}
    self.left, self.top = Screen:scaleBySize(20), Screen:scaleBySize(20)
    self.step = math.floor((self.width - self.left) / 52)
    self.cell = math.max(2, self.step - Screen:scaleBySize(2))
    self.dimen = Geom:new { w = self.width, h = self.top + self.step * 7 + Screen:scaleBySize(28) }
    local year, month, day = tostring(self.reading.asOf):match("^(%d%d%d%d)%-(%d%d)%-(%d%d)$")
    local today = year and os.time { year = tonumber(year), month = tonumber(month), day = tonumber(day), hour = 12 }
    today = today or os.time()
    local ending = today + ((7 - tonumber(os.date("%w", today))) % 7) * 86400
    local seconds = {}
    for _, entry in ipairs(self.reading.days) do seconds[entry.date] = tonumber(entry.seconds) or 0 end
    local previous_month
    for index = 1, 364 do
        local epoch = ending - (364 - index) * 86400
        local date, current_month = os.date("%Y-%m-%d", epoch), os.date("%m", epoch)
        local value = seconds[date] or 0
        self.cells[index] = { date = date, seconds = value, future = epoch > today,
            level = value >= 3600 and 4 or value >= 1800 and 3 or value >= 900 and 2 or value > 0 and 1 or 0 }
        if (index - 1) % 7 == 0 and current_month ~= previous_month then
            if index > 1 or tonumber(os.date("%d", epoch)) <= 7 then
                self.labels[#self.labels + 1] = { widget = label(tonumber(current_month) .. "月", 8), x = self.left + math.floor((index - 1) / 7) * self.step, y = 0 }
            end
            previous_month = current_month
        end
    end
    for _, entry in ipairs({ { "一", 0 }, { "三", 2 }, { "日", 6 } }) do
        self.labels[#self.labels + 1] = { widget = label(entry[1], 8), x = 0, y = self.top + entry[2] * self.step }
    end
    self.labels[#self.labels + 1] = { widget = label("少", 8), x = self.width - Screen:scaleBySize(98), y = self.top + self.step * 7 + Screen:scaleBySize(8) }
    self.labels[#self.labels + 1] = { widget = label("多", 8), x = self.width - Screen:scaleBySize(12), y = self.top + self.step * 7 + Screen:scaleBySize(8) }
    self.ges_events = { Day = { require("ui/gesturerange"):new { ges = "tap", range = self.dimen } } }
end

function Calendar:paintTo(bb, x, y)
    local BB = require("ffi/blitbuffer")
    self.dimen.x, self.dimen.y = x, y
    self.colors = self.colors or { BB.Color8(245), BB.Color8(195), BB.Color8(145), BB.Color8(85), BB.Color8(25) }
    for index, cell in ipairs(self.cells) do
        local cx = x + self.left + math.floor((index - 1) / 7) * self.step
        local cy = y + self.top + (index - 1) % 7 * self.step
        if not cell.future then
            bb:paintRect(cx, cy, self.cell, self.cell, self.colors[cell.level + 1])
            bb:paintBorder(cx, cy, self.cell, self.cell, 1, BB.COLOR_GRAY)
            if self.selected == index then bb:paintBorder(cx - 2, cy - 2, self.cell + 4, self.cell + 4, 2, BB.COLOR_BLACK) end
        end
    end
    for _, entry in ipairs(self.labels) do entry.widget:paintTo(bb, x + entry.x, y + entry.y) end
    for level = 0, 4 do
        bb:paintRect(x + self.width - Screen:scaleBySize(80) + level * Screen:scaleBySize(13),
            y + self.top + self.step * 7 + Screen:scaleBySize(8), Screen:scaleBySize(10), Screen:scaleBySize(10), self.colors[level + 1])
    end
end

function Calendar:onDay(_, gesture)
    local x, y = gesture.pos.x - self.dimen.x - self.left, gesture.pos.y - self.dimen.y - self.top
    if x < 0 or y < 0 or x >= self.step * 52 or y >= self.step * 7 then return true end
    local index = math.floor(x / self.step) * 7 + math.floor(y / self.step) + 1
    local cell = self.cells[index]
    if cell and not cell.future then
        self.selected = index
        self.detail = require("ui/widget/infomessage"):new { text = cell.date .. "\n阅读 " .. Profile.duration(cell.seconds), face = Font:getFace(require("library").fonts.ui, 20) }
        UIManager:setDirty(self.owner, "ui")
        UIManager:show(self.detail)
    end
    return true
end

function Calendar:free()
    for _, entry in ipairs(self.labels) do entry.widget:free() end
end

function Profile.avatar(data, size)
    if data.avatar then return require("ui/widget/imagewidget"):new { file = data.avatar, width = size, height = size } end
    return require("ui/widget/container/framecontainer"):new { padding = 0, margin = 0, bordersize = 1, radius = math.floor(size / 2),
        require("ui/widget/container/centercontainer"):new { dimen = Geom:new { w = size - 2, h = size - 2 },
            require("ui/widget/textwidget"):new { text = data.initials, face = Font:getFace(require("library").fonts.ui, size > Screen:scaleBySize(40) and 28 or 9) } } }
end

function Profile.button(companion, height)
    local button = InputContainer:new { dimen = Geom:new { w = height, h = height },
        require("ui/widget/container/centercontainer"):new { dimen = Geom:new { w = height, h = height },
            Profile.avatar(Profile.snapshot(companion), height - Screen:scaleBySize(4)) } }
    button.callback = function() return Profile.open(companion) end
    button.ges_events = { Profile = { require("ui/gesturerange"):new { ges = "tap", range = button.dimen } } }
    button.onProfile = function() button.callback(); return true end
    return button
end

function Panel:render(data)
    local VerticalGroup = require("ui/widget/verticalgroup")
    local FrameContainer = require("ui/widget/container/framecontainer")
    local VerticalSpan = require("ui/widget/verticalspan")
    local TextBoxWidget = require("ui/widget/textboxwidget")
    local width, pad = Screen:getWidth(), Screen:scaleBySize(24)
    local offset = self.scroll and self.scroll:getScrolledOffset() or nil
    if self[1] then self[1]:free() end
    self.data = data
    local title = require("ui/widget/titlebar"):new { title = "个人资料", fullscreen = true, width = width,
        title_face = Font:getFace(require("library").fonts.title, 17), left_icon = "chevron.left", right_icon = "close",
        left_icon_tap_callback = function() UIManager:close(self) end, right_icon_tap_callback = function() UIManager:close(self) end }
    local content = VerticalGroup:new { align = "left" }
    local function text(value, size, bold, literary)
        content[#content + 1] = TextBoxWidget:new { text = value, width = width - pad * 2,
            face = Font:getFace(require("library").fonts[literary and "title" or "ui"], size), bold = bold or false }
        content[#content + 1] = VerticalSpan:new { width = Screen:scaleBySize(10) }
    end
    content[#content + 1] = VerticalSpan:new { width = Screen:scaleBySize(16) }
    content[#content + 1] = require("ui/widget/horizontalgroup"):new { align = "center",
        Profile.avatar(data, Screen:scaleBySize(52)),
        require("ui/widget/horizontalspan"):new { width = Screen:scaleBySize(14) },
        VerticalGroup:new { align = "left",
            TextBoxWidget:new { text = data.name, width = width - pad * 2 - Screen:scaleBySize(66), face = Font:getFace(require("library").fonts.title, 19) },
            VerticalSpan:new { width = Screen:scaleBySize(5) },
            TextBoxWidget:new { text = "KindleSpouse · " .. (data.paired and (tostring(data.device) .. " 已配对") or "尚未配对"),
                width = width - pad * 2 - Screen:scaleBySize(66), face = Font:getFace(require("library").fonts.ui, 10) } } }
    content[#content + 1] = VerticalSpan:new { width = Screen:scaleBySize(22) }
    if data.reading then
        local reading = data.reading
        local metrics = require("ui/widget/horizontalgroup"):new { align = "top" }
        local current = reading.asOf == os.date("!%Y-%m-%d", os.time() + 28800)
        self.metrics = { { "今日阅读", current and Profile.duration(reading.todaySeconds) or "待同步" },
            { "累计阅读", Profile.duration(reading.totalSeconds) }, { "读过的书", tostring(reading.bookCount or 0) .. " 本" },
            { "阅读天数", tostring(reading.readingDays or 0) .. " 天" } }
        for _, metric in ipairs(self.metrics) do
            local column = VerticalGroup:new { align = "left" }
            column[1] = TextBoxWidget:new { text = metric[1], width = math.floor((width - pad * 2) / 4), face = Font:getFace(require("library").fonts.ui, 10) }
            column[2] = VerticalSpan:new { width = Screen:scaleBySize(8) }
            column[3] = TextBoxWidget:new { text = metric[2], width = math.floor((width - pad * 2) / 4), face = Font:getFace(require("library").fonts.title, 13) }
            metrics[#metrics + 1] = column
        end
        content[#content + 1] = metrics
        content[#content + 1] = VerticalSpan:new { width = Screen:scaleBySize(22) }
        text("阅读日历", 14, false, true)
        text("最近 52 周 · 按阅读分钟数", 10)
        self.calendar = Calendar:new { width = width - pad * 2, reading = reading, owner = self }
        content[#content + 1] = self.calendar
        text("点击方块查看当天时长 · 记录截至 " .. tostring(reading.asOf), 9)
        text(reading.readingDays == 0 and "尚无阅读记录，请开启 KOReader 阅读统计并同步。" or "来自 KindleSpouse 已同步的 KOReader 阅读记录。", 9)
    else
        self.metrics, self.calendar = nil, nil
        text("阅读统计待同步", 14, false, true)
        text("同步个人资料后显示阅读时间、天数和阅读日历。", 11)
    end
    content[#content + 1] = VerticalSpan:new { width = Screen:scaleBySize(8) }
    text("同步情况", 14, false, true)
    text(data.status, 12)
    if data.detail ~= "" then text(data.detail, 11) end
    if data.last_sync then text("上次同步：" .. data.last_sync, 10) end
    if data.profile_received then
        text("资料更新：" .. tostring(data.profile_received):gsub("T", " "):gsub("%.%d+Z$", " UTC"):gsub("Z$", " UTC") .. " · " .. data.route, 10)
    end
    text("绑定的网盘", 14, false, true)
    if data.clouds == nil then text("尚未收到网盘资料，请同步个人资料。", 11)
    elseif #data.clouds == 0 then text("KindleSpouse 尚未绑定网盘。", 11)
    else
        for _, cloud in ipairs(data.clouds) do
            local provider = cloud.provider == "drive" and "Google Drive" or cloud.provider == "onedrive" and "OneDrive" or "网盘"
            text(provider .. " · " .. tostring(cloud.name or ""), 12, true)
            text(cloud.connected and "电脑端已连接" or "需要在 KindleSpouse 重新连接", 10)
        end
        text("网盘信息来自最近一次资料同步。", 10)
    end
    if not data.paired then text("请在电脑 KindleSpouse 中完成设备配对。", 11) end
    local busy = data.state == "running" or data.state == "pausing"
    local buttons = {
        { id = "profile", text = "同步资料", enabled = data.paired and not busy, callback = function() self.companion:syncProfile(); self:refreshNow() end },
        { id = "sync", text = data.state == "paused" and "继续同步" or "立即同步", enabled = data.paired and not busy,
            callback = function() self.companion:sync(false); self:refreshNow() end },
        { id = "pause", text = "暂停", enabled = data.paired and data.state == "running", callback = function() self.companion:pause(); self:refreshNow() end },
    }
    for _, button in ipairs(buttons) do button.font_size = 12; button.font_face = require("library").fonts.ui; button.font_bold = false end
    self.actions = require("ui/widget/buttontable"):new { width = width, buttons = { buttons } }
    self.scroll = require("ui/widget/container/scrollablecontainer"):new { swipe_full_view = false,
        dimen = Geom:new { w = width, h = Screen:getHeight() - title:getHeight() - self.actions:getSize().h },
        FrameContainer:new { padding = 0, padding_left = pad, padding_right = pad, bordersize = 0, content } }
    if offset then self.scroll:setScrolledOffset(offset) end
    self[1] = FrameContainer:new { padding = 0, margin = 0, bordersize = 0,
        width = width, height = Screen:getHeight(), background = require("ffi/blitbuffer").COLOR_WHITE,
        VerticalGroup:new { align = "left", title, self.scroll, self.actions } }
    self.signature = json.encode(data)
end

function Panel:refreshNow()
    if self.closed then return end
    local data = Profile.snapshot(self.companion)
    if json.encode(data) ~= self.signature then self:render(data); UIManager:setDirty(self, "ui") end
end

function Panel:onCloseWidget()
    if self.closed then return end
    self.closed = true
    UIManager:unschedule(self.refresh_task)
    if self.companion.profile_panel == self then self.companion.profile_panel = nil end
    if self.companion.ui and self.companion.ui.file_chooser then
        self.companion.ui:reinit(self.companion.ui.file_chooser.path)
        UIManager:setDirty(self.companion.ui, "ui")
    end
    if self[1] then self[1]:free(); self[1] = nil end
end

function Profile.open(companion)
    if companion.profile_panel and not companion.profile_panel.closed then return companion.profile_panel end
    local panel = Panel:new { companion = companion, dimen = Screen:getSize() }
    panel:render(Profile.snapshot(companion))
    panel.refresh_task = function()
        if panel.closed then return end
        panel:refreshNow()
        UIManager:scheduleIn(3, panel.refresh_task)
    end
    companion.profile_panel = panel
    UIManager:show(panel)
    UIManager:scheduleIn(3, panel.refresh_task)
    return panel
end

return Profile
