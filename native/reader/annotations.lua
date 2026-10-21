local M = {}

function M.locate(reader, anchor, file_hash)
    local doc = reader.document
    local function missing(message, accuracy)
        return { found = false, accuracy = accuracy or "missing", message = message }
    end
    if reader.view and reader.view.highlight then reader.view.highlight.temp = {} end
    if doc.clearSelection then doc:clearSelection() end
    local quote = type(anchor.quote) == "string" and anchor.quote or ""
    local item
    if reader.rolling and anchor.fileHash == file_hash and type(anchor.sourcePosition) == "string" then
        local ok, page = pcall(doc.getPageFromXPointer, doc, anchor.sourcePosition)
        if ok and page and page > 0 then
            if quote == "" then
                item = { start = anchor.sourcePosition, ["end"] = anchor.sourcePosition }
            elseif type(anchor.endPosition) == "string" then
                local valid, text = pcall(doc.getTextFromXPointers, doc, anchor.sourcePosition, anchor.endPosition)
                if valid and type(text) == "string" and text:gsub("%s+", " ") == quote:gsub("%s+", " ") then
                    item = { start = anchor.sourcePosition, ["end"] = anchor.endPosition }
                end
            end
        end
    end
    if not item and quote ~= "" then
        local ok, hits = pcall(doc.findAllText, doc, quote, true, 0, 100, false, 0)
        if ok and hits and #hits > 0 then
            if #hits == 1 then item = hits[1]
            elseif not reader.rolling and anchor.fileHash == file_hash and anchor.page then
                for _, hit in ipairs(hits) do
                    if hit.start == anchor.page then
                        if item then return missing("同一页有多处相同引文，请核对版本。", "ambiguous") end
                        item = hit
                    end
                end
            end
            if not item then return missing("此版本有多处相同引文，尚未确定位置。", "ambiguous") end
        end
    end
    if item then
        local page
        if reader.rolling then
            reader.rolling:onGotoXPointer(item.start, item.start)
            doc:getTextFromXPointers(item.start, item["end"], true)
            page = doc:getPageFromXPointer(item.start)
        else
            page = item.start
            reader.paging:enterSkimMode()
            reader.link:onGotoLink({ page = page - 1 })
            local boxes = {}
            for i, box in ipairs(item.boxes or {}) do boxes[i] = doc:nativeToPageRectTransform(page, box) end
            reader.view.highlight.temp[page] = boxes
        end
        require("ui/uimanager"):setDirty(reader.view, "full")
        return { found = true, accuracy = "exact", page = page,
            start = type(item.start) == "string" and item.start or nil,
            ["end"] = type(item["end"]) == "string" and item["end"] or nil }
    end
    if not reader.rolling and anchor.format == "pdf" and anchor.page and anchor.page <= doc:getPageCount() then
        reader.link:onGotoLink({ page = anchor.page - 1 })
        require("ui/uimanager"):setDirty(reader.view, "full")
        return missing(quote == "" and "已跳到书签来源页。" or "已跳到来源页，未匹配引文；请检查文字层和版本。", "page")
    end
    return missing(quote == "" and "此书签没有可用于该版本的正文位置。" or "此版本未找到引文；请核对版本，扫描 PDF 可能没有文字层。")
end

return M
