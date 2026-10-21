local UIManager = require("ui/uimanager")
local project = assert(os.getenv("KINDLESPOUSE_TEST_ROOT"))
local staging = assert(os.getenv("KINDLESPOUSE_PREVIEW_STAGING"))
local engine = assert(loadfile(project .. "/experiments/notebook/embedded.lua"))().new(staging .. "/files/koreader/kindlespouse-notebook/engine")
local Import = assert(loadfile(project .. "/experiments/notebook/import.lua"))()
local function read(filename)
    local file = assert(io.open(filename, "rb"))
    local data = require("json").decode(file:read("*a"))
    file:close()
    return data
end
UIManager:scheduleIn(1, function()
    local ok, failure = pcall(function()
        local input = read(staging .. "/converted-linux.json")
        local imported, skipped, pages, strokes = 0, 0, 0, 0
        local results = {}
        for _, item in ipairs(input.converted) do
            local saved, counts = pcall(function()
                local data = read(item.vector)
                local document, count = Import.document(engine.load, data, input.destination .. "/" .. item.filename, { x = 0, y = 160, w = 1860, h = 2200 })
                assert(document:save())
                return count
            end)
            if saved then
                imported = imported + 1
                pages = pages + counts.pages
                strokes = strokes + counts.strokes
                results[#results + 1] = { filename = item.filename, sha256 = item.sha256, pages = counts.pages, strokes = counts.strokes }
            else
                skipped = skipped + 1
            end
        end
        local file = assert(io.open(staging .. "/import-result.json", "wb"))
        file:write(require("json").encode { imported = imported, skipped = skipped, pages = pages, strokes = strokes, notebooks = results })
        file:close()
        print(string.format("Preview copies prepared: %d notebooks, %d pages, %d strokes; %d unsupported imports.", imported, pages, strokes, skipped))
    end)
    if not ok then print("Preview import preparation failed: " .. tostring(failure)) end
    UIManager:quit(ok and 0 or 1)
end)
