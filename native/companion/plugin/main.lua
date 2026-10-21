local WidgetContainer = require("ui/widget/container/widgetcontainer")
local UIManager = require("ui/uimanager")
local InfoMessage = require("ui/widget/infomessage")
local Notification = require("ui/widget/notification")
local NetworkMgr = require("ui/network/manager")
local lfs = require("libs/libkoreader-lfs")
local json = require("json")

local directory = "/mnt/us/kindlespouse/"
local stages = {
    syncing_titles = "Syncing notebook titles first",
    checking_pairing = "Checking cloud connection",
    receiving_profile = "Receiving profile and sleep-cover settings",
    checking_local_profile = "Connecting to your computer",
    receiving_local_profile = "Receiving profile over local network",
    checking_inbox = "Checking incoming books",
    checking_book_folder = "Checking Kindle book folder",
    receiving_folder_books = "Receiving missing cloud books",
    receiving_books = "Receiving books",
    saving_receipts = "Confirming received books",
    scanning_notes = "Preparing notes and annotations",
    backing_up_catalog = "Preparing titles and reading history",
    checking_cloud = "Checking existing cloud backups",
    uploading_notes = "Uploading changed files",
    packing_notes = "Packing changed notes and annotations",
    uploading_bundles = "Uploading sync bundles",
    publishing = "Verifying cloud snapshot",
    receiving_annotations = "Receiving annotation edits",
}
local Companion = WidgetContainer:extend { name = "kindlespouse", is_doc_only = false }

local function readJSON(name)
    local file = io.open(directory .. name, "r")
    if not file then return end
    local data = file:read(65536)
    file:close()
    if not data or data == "" then return end
    local ok, value = pcall(json.decode, data)
    if ok and type(value) == "table" then return value end
end

function Companion:isRunning()
    local lock = io.open(directory .. "sync.lock", "r")
    if not lock then return false end
    local pid = lock:read(32)
    lock:close()
    pid = pid and pid:match("^(%d+)%s*$")
    if not pid then return false end
    local process = io.open("/proc/" .. pid .. "/cmdline", "r")
    if not process then return false end
    local command = process:read(4096)
    process:close()
    return command and command:find("kindlespouse%-sync") ~= nil
end

function Companion:status()
    if self.launch_error then return { state = "failed", error = self.launch_error } end
    local progress = readJSON("progress.json")
    local pause_file = progress and progress.profileOnly and "profile-pause.requested"
        or progress and progress.titlesOnly and "titles-pause.requested"
        or progress and progress.booksOnly and "books-pause.requested" or "pause.requested"
    local paused = lfs.attributes(directory .. pause_file, "mode")
    if paused then
        progress = progress or {}
        progress.state = self:isRunning() and "pausing" or "paused"
        return progress
    end
    if progress and type(progress.state) == "string" then
        if progress.state == "running" and not self:isRunning() then
            progress.state = "failed"
            progress.error = "Sync was interrupted. Connect Wi-Fi and select Sync now to retry."
        end
        return progress
    end
    if lfs.attributes(directory .. "sync.lock", "mode") then
        return { state = self:isRunning() and "running" or "failed", stage = "checking_pairing",
                 error = "Previous sync was interrupted. Select Sync now to retry." }
    end
    local result = readJSON("last-result.json")
    if result then
        return { state = result.ok and "completed" or "failed", error = result.error, received = result.received, files = result.files,
                 booksOnly = result.booksOnly, profileOnly = result.profileOnly, titlesOnly = result.titlesOnly, updatesOnly = result.updatesOnly }
    end
    return { state = "idle" }
end

function Companion:summary(progress)
    if progress.state == "paused" then return "Sync paused. Uploaded files are kept. Select Resume sync to continue." end
    if progress.state == "pausing" then return "Pausing sync... Uploaded files are kept." end
    if progress.state == "idle" then return "No completed sync yet." end
    if progress.state == "completed" then
        if progress.updatesOnly then return "Cloud preferences and annotation edits checked." end
        if progress.booksOnly then return string.format("Books synced: %d received.", tonumber(progress.received) or 0) end
        if progress.profileOnly then return progress.profileRoute == "lan" and "Profile synced via local network." or "Profile synced via cloud." end
        if progress.titlesOnly then return "Notebook titles synced. Full backup remains paused." end
        return string.format("Sync complete: %d books received, %d files backed up.", tonumber(progress.received) or 0, tonumber(progress.files) or 0)
    end
    if progress.state == "failed" then return "Sync stopped: " .. tostring(progress.error or "Check Wi-Fi and retry.") end
    local text = stages[progress.stage] or "Starting background sync"
    local done, total = tonumber(progress.done) or 0, tonumber(progress.total) or 0
    if total > 0 then text = text .. string.format(" (%d/%d)", done, total)
    elseif done > 0 then text = text .. string.format(" (%d files)", done) end
    local bytes, total_bytes, speed = tonumber(progress.bytes) or 0, tonumber(progress.totalBytes) or 0, tonumber(progress.speed) or 0
    if total_bytes > 0 then text = text .. string.format(" · %.1f/%.1f MiB", bytes / 1048576, total_bytes / 1048576) end
    if speed > 0 then text = text .. string.format(" · %.0f KiB/s", speed / 1024) end
    if tonumber(progress.startedAt) then
        local elapsed = math.max(0, (tonumber(progress.completedAt) or os.time()) - progress.startedAt)
        text = text .. string.format(" · %dm %02ds", math.floor(elapsed / 60), elapsed % 60)
    end
    return text
end

function Companion:syncTitles()
    if self:isRunning() or self.launch_pending then self:notify("KindleSpouse: pause the current sync first."); return end
    if not NetworkMgr:isConnected() then self:notify("KindleSpouse: connect Wi-Fi to sync titles."); return end
    self.launch_error = nil
    os.remove(directory .. "titles-pause.requested")
    self.launch_started = os.time()
    self.launch_pending = true
    os.execute("sh /mnt/us/kindlespouse/sync.sh titles < /dev/null > /dev/null 2>&1 &")
    self:notify("KindleSpouse: syncing titles only. Full backup remains paused.")
    self:watch(true)
end

function Companion:notify(text)
    UIManager:show(Notification:new { text = text, timeout = 3, toast = true })
end

function Companion:syncProfile()
    if self:isRunning() or self.launch_pending then self:notify("KindleSpouse: pause the current sync first."); return end
    if not NetworkMgr:isConnected() then self:notify("KindleSpouse: connect Wi-Fi to sync your profile."); return end
    if not lfs.attributes(directory .. "config.json", "mode") then self:notify("KindleSpouse: pair this Kindle first."); return end
    self.launch_error = nil
    os.remove(directory .. "profile-pause.requested")
    self.launch_started = os.time()
    self.launch_pending = true
    os.execute("sh /mnt/us/kindlespouse/sync.sh profile < /dev/null > /dev/null 2>&1 &")
    self:notify("KindleSpouse: syncing profile. Local network first, cloud as fallback.")
    self:watch(true)
end

function Companion:init()
    self.ui.menu:registerToMainMenu(self)
    if self.ui.registerPostInitCallback then require("home").install(self) end
    UIManager:scheduleIn(2, function() self:applyAnnotations() end)
    if G_reader_settings then self:applySleepProfile() end
    if lfs.attributes(directory .. "catalog.requested", "mode") then
        os.remove(directory .. "catalog.requested")
        UIManager:scheduleIn(1, function() self:collectTitles() end)
    end
    self.auto_receive_task = function()
        if not G_reader_settings or G_reader_settings:readSetting("kindlespouse_auto_receive") ~= false then self:receiveBooks(true) end
        UIManager:scheduleIn(90, self.auto_receive_task)
    end
    UIManager:scheduleIn(8, self.auto_receive_task)
    self.auto_sync_check = not self.ui.document
    self.auto_sync_task = function()
        self:automaticSync()
        UIManager:scheduleIn(30, self.auto_sync_task)
    end
    UIManager:scheduleIn(6, self.auto_sync_task)
end

function Companion:autoSyncEnabled()
    return not G_reader_settings or G_reader_settings:readSetting("kindlespouse_auto_sync") ~= false
end

function Companion:automaticSync()
    if self.suspended or not self:autoSyncEnabled() then return end
    if self.launch_pending or self:isRunning() then self:watch(false); return end
    local previous = G_reader_settings and tonumber(G_reader_settings:readSetting("kindlespouse_last_sync")) or 0
    local dirty = G_reader_settings and G_reader_settings:readSetting("kindlespouse_sync_dirty")
    local reading_dirty = G_reader_settings and G_reader_settings:readSetting("kindlespouse_reading_dirty")
    if os.time() < (self.retry_after or 0) then return end
    if previous and os.time() < previous + 60 then return end
    if dirty or self.auto_sync_check or reading_dirty and os.time() >= previous + 600 then
        self:sync(true)
        return
    end
    local checked = G_reader_settings and tonumber(G_reader_settings:readSetting("kindlespouse_last_updates")) or 0
    if os.time() >= checked + 600 then self:checkUpdates() end
end

function Companion:checkUpdates()
    if self.suspended or not self:autoSyncEnabled() or self.launch_pending or self:isRunning() then return end
    if lfs.attributes(directory .. "pause.requested", "mode") or not NetworkMgr:isConnected() or not lfs.attributes(directory .. "config.json", "mode") then return end
    self.launch_error = nil
    self.launch_started = os.time()
    local result = os.execute("sh /mnt/us/kindlespouse/sync.sh updates < /dev/null > /dev/null 2>&1 &")
    if result ~= 0 and result ~= true then self.retry_after = os.time() + 60; return end
    self.launch_pending = true
    self:watch(false)
end

function Companion:onPageUpdate(page)
    if page == self.reading_page then return end
    self.reading_page = page
    if G_reader_settings then
        G_reader_settings:saveSetting("kindlespouse_reading_dirty", true)
        G_reader_settings:saveSetting("kindlespouse_sync_generation", (tonumber(G_reader_settings:readSetting("kindlespouse_sync_generation")) or 0) + 1)
    end
end

function Companion:queueAutomaticSync(delay)
    if G_reader_settings then
        G_reader_settings:saveSetting("kindlespouse_sync_dirty", true)
        G_reader_settings:saveSetting("kindlespouse_sync_generation", (tonumber(G_reader_settings:readSetting("kindlespouse_sync_generation")) or 0) + 1)
    end
    if self.suspended or not self.auto_sync_task then return end
    UIManager:unschedule(self.auto_sync_task)
    UIManager:scheduleIn(delay or 15, self.auto_sync_task)
end

function Companion:onAnnotationsModified()
    self:queueAutomaticSync(15)
end

function Companion:saveReadingState()
    local ok = pcall(function()
        local reader = require("apps/reader/readerui").instance
        if reader and reader.document then reader:saveSettings() end
    end)
    return ok
end

function Companion:receiveBooks(silent)
    if self.suspended then return end
    if self.launch_pending or self:isRunning() or lfs.attributes(directory .. "books-pause.requested", "mode") then return end
    if not NetworkMgr:isConnected() or not lfs.attributes(directory .. "config.json", "mode") then return end
    self.launch_error = nil
    self.launch_started = os.time()
    local result = os.execute("sh /mnt/us/kindlespouse/sync.sh books < /dev/null > /dev/null 2>&1 &")
    if result ~= 0 and result ~= true then return end
    self.launch_pending = true
    if not silent then self:notify("KindleSpouse: checking for new books in background.") end
    self:watch(not silent)
end

function Companion:onSuspend()
    self.suspended = true
    if self.auto_receive_task then UIManager:unschedule(self.auto_receive_task) end
    if self.auto_sync_task then UIManager:unschedule(self.auto_sync_task) end
    if self.watch_task then UIManager:unschedule(self.watch_task) end
end

function Companion:onResume()
    self.suspended = false
    if self.auto_receive_task then UIManager:unschedule(self.auto_receive_task); UIManager:scheduleIn(8, self.auto_receive_task) end
    if self.auto_sync_task then UIManager:unschedule(self.auto_sync_task); UIManager:scheduleIn(6, self.auto_sync_task) end
    if self.watch_task then UIManager:unschedule(self.watch_task); UIManager:scheduleIn(1, self.watch_task) end
end

function Companion:onNetworkConnected()
    self.retry_after = nil
    if self.suspended then return end
    if self.auto_sync_task then UIManager:unschedule(self.auto_sync_task); UIManager:scheduleIn(6, self.auto_sync_task) end
    if self.auto_receive_task then UIManager:unschedule(self.auto_receive_task); UIManager:scheduleIn(8, self.auto_receive_task) end
end

function Companion:applySleepProfile()
    local profile = readJSON("sleep-profile.json")
    if not profile or type(profile.revision) ~= "string" or profile.version ~= 1 then return end
    if G_reader_settings:readSetting("kindlespouse_sleep_revision") == profile.revision then return end
    self:setSleepCover(profile.enabled)
    G_reader_settings:saveSetting("kindlespouse_sleep_revision", profile.revision)
    self:prepareSleepCover()
end

function Companion:prepareSleepCover()
    UIManager:scheduleIn(0.5, function()
        pcall(function()
            local preset = require("spouse_preset")
            local reader = require("apps/reader/readerui").instance
            if reader and reader.document then preset.prepare(reader) end
        end)
    end)
end

function Companion:onReaderReady()
    self:prepareSleepCover()
    self:onPageUpdate(0)
end

function Companion:setSleepCover(enabled)
    local current = G_reader_settings:readSetting("screensaver_type")
    if enabled then
        if current ~= "customisable_ss" then G_reader_settings:saveSetting("kindlespouse_previous_screensaver", current or "cover") end
        G_reader_settings:saveSetting("screensaver_type", "customisable_ss")
    elseif current == "customisable_ss" then
        G_reader_settings:saveSetting("screensaver_type", G_reader_settings:readSetting("kindlespouse_previous_screensaver", "cover"))
    end
end

function Companion:applyAnnotations()
    local ok, count = pcall(function() return require("annotation_apply").run(directory) end)
    if ok and count > 0 then
        self:queueAutomaticSync(15)
        UIManager:scheduleIn(0.5, function() self:applyAnnotations() end)
    end
end

function Companion:collectTitles()
    local started = os.time()
    os.execute("sh /mnt/us/kindlespouse/catalog.sh < /dev/null > /dev/null 2>&1 &")
    self:notify("KindleSpouse: preparing notebook titles offline.")
    local attempts = 0
    local check
    check = function()
        attempts = attempts + 1
        local result = readJSON("catalog-result.json")
        if result and tonumber(result.completedAt) and result.completedAt >= started then
            self:notify(result.ok and "KindleSpouse: title index ready. You can reconnect USB." or "KindleSpouse: could not read title index.")
        elseif attempts < 15 then UIManager:scheduleIn(2, check)
        else self:notify("KindleSpouse: title collection stopped. Try Collect notebook titles again.") end
    end
    UIManager:scheduleIn(2, check)
end

function Companion:watch(notify_completion)
    self.notify_completion = self.notify_completion or notify_completion
    if self.watch_task then return end
    local attempts = 0
    self.watch_task = function()
        local progress = self:status()
        if G_reader_settings then self:applySleepProfile() end
        attempts = attempts + 1
        local fresh = tonumber(progress.startedAt) and progress.startedAt >= (self.launch_started or 0)
        if self.launch_pending and not fresh and attempts >= 3 then
            self.launch_error = "Could not start sync. Open Sync status, then retry Sync now."
            progress = self:status()
        end
        if progress.state == "running" or progress.state == "pausing" or self.launch_pending and not fresh and attempts < 3 then
            if progress.state == "running" then self.launch_pending = false end
            UIManager:scheduleIn(5, self.watch_task)
            return
        end
        self.launch_pending = false
        self.watch_task = nil
        local full = not (progress.booksOnly or progress.profileOnly or progress.titlesOnly or progress.updatesOnly)
        if full or progress.updatesOnly then
            if progress.state == "completed" then
                self.retry_count, self.retry_after = 0, nil
                if G_reader_settings then
                    G_reader_settings:saveSetting("kindlespouse_last_updates", os.time())
                    if full then
                        G_reader_settings:saveSetting("kindlespouse_last_sync", os.time())
                        if self.sync_generation ~= nil and G_reader_settings:readSetting("kindlespouse_sync_generation", 0) == self.sync_generation then
                            G_reader_settings:saveSetting("kindlespouse_sync_dirty", false)
                            G_reader_settings:saveSetting("kindlespouse_reading_dirty", false)
                        end
                    end
                end
                if full then self.auto_sync_check = false end
            elseif progress.state == "failed" then
                self.retry_count = math.min((self.retry_count or 0) + 1, 5)
                self.retry_after = os.time() + math.min(60 * 2 ^ (self.retry_count - 1), 900)
            end
        end
        if progress.state == "completed" then self:applyAnnotations() end
        if self.notify_completion then
            if progress.state == "completed" then self:notify(progress.profileOnly and self:summary(progress) or progress.titlesOnly and "KindleSpouse: notebook titles synced." or "KindleSpouse: sync complete.")
            elseif progress.state == "paused" then self:notify("KindleSpouse: sync paused. Uploaded files are kept.")
            else self:notify("KindleSpouse: sync stopped. Open Sync status for details.") end
        end
        self.notify_completion = false
    end
    UIManager:scheduleIn(1, self.watch_task)
end

function Companion:pause()
    for _, name in ipairs({ "pause.requested", "titles-pause.requested", "profile-pause.requested", "books-pause.requested" }) do
        local file = io.open(directory .. name, "w")
        if not file then self:notify("KindleSpouse: cannot save pause request."); return end
        file:write("paused\n")
        file:close()
    end
    self.launch_pending = false
    self.launch_error = nil
    self:notify("KindleSpouse: pausing sync. Uploaded files are kept.")
    self:watch(false)
end

function Companion:showStatus()
    if self.status_dialog then UIManager:close(self.status_dialog) end
    local dialog
    local refresh
    local function text()
        local progress = self:status()
        local hint = progress.state == "running" and "Sync continues in the background. " or ""
        return self:summary(progress) .. "\n\n" .. hint .. "Tap to return to reading."
    end
    dialog = InfoMessage:new {
        text = text(), show_icon = false,
        dismiss_callback = function()
            self.status_dialog = nil
            if refresh then UIManager:unschedule(refresh) end
        end,
    }
    self.status_dialog = dialog
    UIManager:show(dialog)
    refresh = function()
        if self.status_dialog ~= dialog then return end
        local value = text()
        if dialog.text ~= value then
            local previous_area = dialog:getVisibleArea()
            dialog:free()
            dialog.text = value
            dialog:init()
            UIManager:setDirty(nil, "ui", previous_area)
            UIManager:setDirty(dialog, "ui")
        end
        if self:isRunning() then UIManager:scheduleIn(3, refresh) end
    end
    if self:isRunning() then UIManager:scheduleIn(3, refresh) end
end

function Companion:sync(silent)
    if silent and (self.suspended or not self:autoSyncEnabled()) then return end
    if silent and lfs.attributes(directory .. "pause.requested", "mode") then return end
    if self.launch_pending or self:isRunning() then
        if not silent then self:notify("KindleSpouse: already syncing in background.") end
        self:watch(not silent)
        return
    end
    if not lfs.attributes(directory .. "config.json", "mode") then
        if not silent then self:notify("KindleSpouse: pair this Kindle from the desktop app first.") end
        return
    end
    if not NetworkMgr:isConnected() then
        if not silent then self:notify("KindleSpouse: connect Wi-Fi, then select Sync now.") end
        return
    end
    if not self:saveReadingState() then
        if not silent then self:notify("KindleSpouse: could not save reading state. Sync will retry later.") end
        self.retry_after = os.time() + 60
        return
    end
    os.remove(directory .. "pause.requested")
    if not silent then os.remove(directory .. "books-pause.requested") end
    self.launch_error = nil
    self.launch_started = os.time()
    self.sync_generation = G_reader_settings and G_reader_settings:readSetting("kindlespouse_sync_generation", 0) or 0
    local result = os.execute("sh /mnt/us/kindlespouse/sync.sh < /dev/null > /dev/null 2>&1 &")
    if result ~= 0 and result ~= true then
        if not silent then self:notify("KindleSpouse: could not start sync. Try again.") end
        return
    end
    self.launch_pending = true
    if not silent then self:notify("KindleSpouse: syncing in background. You can keep reading.") end
    self:watch(not silent)
end

function Companion:addToMainMenu(menu_items)
    menu_items.kindlespouse = { text = "KindleSpouse", sub_item_table = {
        { text = "Profile and cloud sync", callback = function() require("profile").open(self) end },
        { text = "Use KindleSpouse home", enabled_func = function() return not self.ui.document end,
          checked_func = function() return G_reader_settings:readSetting("kindlespouse_home") ~= false end,
          callback = function() if not self.ui.document then require("home").toggle(self) end end },
        { text_func = function() return lfs.attributes(directory .. "pause.requested", "mode") and "Resume sync" or "Sync now" end,
          callback = function() self:sync(false) end },
        { text = "Pause sync", callback = function() self:pause() end },
        { text = "Sync profile now", callback = function() self:syncProfile() end },
        { text = "Check for new books", callback = function() self:receiveBooks(false) end },
        { text = "Automatically receive books", checked_func = function() return not G_reader_settings or G_reader_settings:readSetting("kindlespouse_auto_receive") ~= false end,
          callback = function() if G_reader_settings then local enabled = G_reader_settings:readSetting("kindlespouse_auto_receive") == false; G_reader_settings:saveSetting("kindlespouse_auto_receive", enabled); if enabled then os.remove(directory .. "books-pause.requested"); self:receiveBooks(true) end end end },
        { text = "Automatically sync notes and reading history", checked_func = function() return self:autoSyncEnabled() end,
          callback = function()
              if G_reader_settings then
                  local enabled = not self:autoSyncEnabled()
                  G_reader_settings:saveSetting("kindlespouse_auto_sync", enabled)
                  if enabled then os.remove(directory .. "pause.requested"); self.retry_after = nil; self:queueAutomaticSync(1) end
              end
          end },
        { text_func = function() return "Sync status: " .. self:summary(self:status()) end,
          callback = function() self:showStatus() end },
        { text = "Last result", callback = function() self:showStatus() end },
        { text = "Collect notebook titles", callback = function() self:collectTitles() end },
        { text = "Sync titles", callback = function() self:syncTitles() end },
        { text = "Apply pending annotation edits", callback = function() self:applyAnnotations() end },
        { text = "Use KindleSpouse sleep cover", checked_func = function() return G_reader_settings:readSetting("screensaver_type") == "customisable_ss" end,
          callback = function()
              local profile = readJSON("sleep-profile.json") or { version = 1, displayName = "Reader", avatar = "R" }
              profile.enabled = G_reader_settings:readSetting("screensaver_type") ~= "customisable_ss"
              local file = io.open(directory .. "sleep-profile.json.partial", "wb")
              if not file then self:notify("Cannot save sleep cover preference."); return end
              file:write(json.encode(profile)); file:close()
              os.rename(directory .. "sleep-profile.json.partial", directory .. "sleep-profile.json")
              self:setSleepCover(profile.enabled)
          end },
    } }
end

function Companion:onCloseDocument()
    UIManager:scheduleIn(1, function() self:applyAnnotations() end)
    self:queueAutomaticSync(2)
end

function Companion:onCloseWidget()
    self.suspended = true
    if self.auto_receive_task then UIManager:unschedule(self.auto_receive_task) end
    if self.auto_sync_task then UIManager:unschedule(self.auto_sync_task) end
    if self.watch_task then UIManager:unschedule(self.watch_task) end
    if self.status_dialog then UIManager:close(self.status_dialog) end
end

return Companion
