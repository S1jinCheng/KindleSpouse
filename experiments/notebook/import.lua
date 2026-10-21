local Import = {}

local function finite(value)
    return type(value) == "number" and value == value and math.abs(value) < 100000000
end

function Import.document(load, data, path, content)
    assert(data.version == 1 and type(data.pages) == "table" and #data.pages > 0 and #data.pages <= 1000, "Unsupported notebook vector data")
    assert(path:match("%.scribe$") and not path:match("/%.notebooks/"), "Imported edits require separate storage")
    local Document, Stroke = load("document"), load("stroke")
    local document = Document:new(path)
    document.pages = {}
    local points, strokes = 0, 0
    for _, source in ipairs(data.pages) do
        assert(finite(source.width) and finite(source.height) and source.width > 0 and source.height > 0, "Invalid page dimensions")
        assert(type(source.strokes) == "table", "Missing strokes")
        local scale = math.min(content.w / source.width, content.h / source.height)
        local page = { strokes = {} }
        for _, original in ipairs(source.strokes) do
            assert(type(original.points) == "table" and #original.points > 0, "Missing stroke points")
            points = points + #original.points
            strokes = strokes + 1
            assert(points <= 5000000 and strokes <= 100000, "Notebook exceeds experimental import limit")
            local width = 0
            for _, point in ipairs(original.points) do
                assert(finite(point.x) and finite(point.y) and finite(point.width) and point.width >= 0, "Invalid stroke point")
                width = math.max(width, point.width * scale)
            end
            local stroke = Stroke:new { tool = original.opacity and original.opacity < 0.8 and "highlighter" or "pen", width = math.max(0.2, width), color = 0 }
            for _, point in ipairs(original.points) do
                stroke:addPoint(content.x + point.x * scale, content.y + point.y * scale, math.max(0.05, math.min(1, point.width * scale / stroke.width)))
            end
            page.strokes[#page.strokes + 1] = stroke
        end
        document.pages[#document.pages + 1] = page
    end
    document.page_size = { w = content.w, h = content.h }
    document.content_origin = { x = content.x, y = content.y }
    document.template = "blank"
    document.dirty = true
    return document, { pages = #document.pages, strokes = strokes, points = points }
end

return Import
