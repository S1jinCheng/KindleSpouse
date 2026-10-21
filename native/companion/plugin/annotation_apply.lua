local M = {}
local function matches(item, expected)
    return (item.text or "") == expected.text and (item.note or "") == expected.note
        and (item.datetime or "") == expected.datetime
        and (type(item.pos0) == "string" and item.pos0 or "") == expected.pos0
        and (type(item.pos1) == "string" and item.pos1 or "") == expected.pos1
        and (not expected.page or (item.pageno or item.page) == expected.page)
end

function M.apply(settings, job)
    local completed = settings:readSetting("kindlespouse_applied_jobs") or {}
    if completed[job.jobId] then return "applied" end
    local annotations = settings:readSetting("annotations")
    if type(annotations) ~= "table" then return "conflict" end
    local index
    for i, item in ipairs(annotations) do
        if matches(item, job.expected) then
            if index then return "conflict" end
            index = i
        end
    end
    if not index then return "conflict" end
    if job.operation == "delete" then table.remove(annotations, index)
    elseif job.operation == "edit" then annotations[index].note = job.note ~= "" and job.note or nil
    else return "conflict" end
    completed[job.jobId] = true
    settings:saveSetting("annotations", annotations)
    settings:saveSetting("kindlespouse_applied_jobs", completed)
    return "applied"
end

function M.run(directory)
    if require("apps/reader/readerui").instance then return 0 end
    local lfs = require("libs/libkoreader-lfs")
    local json = require("json")
    local function read(file, limit)
        local stream = io.open(file, "rb")
        if not stream then return end
        local value = stream:read(limit + 1)
        stream:close()
        if #value <= limit then return value end
    end
    local function write(file, value)
        local stream = assert(io.open(file .. ".partial", "wb"))
        assert(stream:write(value)); assert(stream:close())
        assert(os.rename(file .. ".partial", file))
    end
    local function safe(relative)
        if type(relative) ~= "string" or relative:find("[\\:%c]") or not (relative:match("^Books/") or relative:match("^documents/")) then return false end
        local current = "/mnt/us"
        for part in relative:gmatch("[^/]+") do
            if part == "." or part == ".." then return false end
            current = current .. "/" .. part
            if lfs.symlinkattributes(current, "mode") == "link" then return false end
        end
        return not relative:find("//", 1, true)
    end
    local queue = directory .. "annotation-jobs/"
    if lfs.attributes(queue, "mode") ~= "directory" then return 0 end
    require("util").makePath(directory .. "annotation-results")
    require("util").makePath(directory .. "annotation-backups")
    local processed = 0
    for filename in lfs.dir(queue) do
        if filename:match("^[%da-fA-F%-]+%.json$") then
            local bytes = read(queue .. filename, 200000)
            local ok, job = pcall(json.decode, bytes or "")
            if ok and type(job) == "table" and job.jobId .. ".json" == filename and type(job.expected) == "table" and safe(job.bookRelative) and safe(job.relative) then
                local status = "conflict"
                local target = "/mnt/us/" .. job.bookRelative
                local info = lfs.attributes(target)
                if info and info.size == job.bookSize and info.modification == job.bookModified then
                    local original = read("/mnt/us/" .. job.relative, 10485760)
                    if original then
                        local backup = directory .. "annotation-backups/" .. filename .. ".lua"
                        if not lfs.attributes(backup) then write(backup, original) end
                        local settings = require("docsettings"):open(target)
                        local result = M.apply(settings, job)
                        if result == "applied" and settings:flush(nil, true) then
                            local verify = require("docsettings"):open(target):readSetting("kindlespouse_applied_jobs")
                            if verify and verify[job.jobId] then status = "applied" end
                        end
                    end
                end
                write(directory .. "annotation-results/" .. filename, json.encode({ jobId = job.jobId, status = status }))
                os.remove(queue .. filename)
                processed = processed + 1
                if processed >= 4 then break end
            end
        end
    end
    return processed
end
return M
