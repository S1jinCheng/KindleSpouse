local UIManager = require("ui/uimanager")
local FileManager = require("apps/filemanager/filemanager")
local expected = tonumber(assert(os.getenv("KINDLESPOUSE_PREVIEW_NOTEBOOKS")))
UIManager:scheduleIn(3, function()
    local ok, failure = pcall(function()
        local ui = assert(FileManager.instance)
        local engine = assert(package.loaded.kindlespouse_notebook_preview)
        assert(ui.kindlespouse_home and require("home").enabled(), "Installed homepage must be active")
        local navigation = ui.layout[#ui.layout]
        assert(#navigation == 2 and navigation[1].text == "Library" and navigation[2].text == "Notebooks")
        navigation[2].callback()
        assert(ui.kindlespouse_tab == "Notebook" and engine.gallery)
        assert(#engine.gallery.items == expected, "All prepared copies must be visible")
        if expected > 0 then
            engine.gallery:_open(engine.gallery.items[1])
            local editor = assert(engine.editor)
            local count = #editor.document:getPage().strokes
            editor.canvas.draw_with_finger = true
            local y = editor.canvas.content.y + 100
            editor.canvas:onTouchStart(nil, { pos = { x = 200, y = y } })
            editor.canvas:onTouchPan(nil, { pos = { x = 300, y = y + 20 } })
            editor.canvas:onTouchRelease(nil, { pos = { x = 300, y = y + 20 } })
            assert(#editor.document:getPage().strokes == count + 1)
            editor:_close()
            assert(not engine.editor)
            local document = engine.load("document"):new(editor.document.path)
            assert(document:load() and #document:getPage().strokes == count + 1)
        end
        ui.layout[#ui.layout][1].callback()
        assert(ui.kindlespouse_tab == "Library" and not engine.gallery)
        ui.layout[#ui.layout][2].callback()
        require("home").toggle { ui = ui }
        assert(not require("home").enabled() and not engine.gallery)
        require("home").toggle { ui = ui }
        assert(require("home").enabled())
        print("Device preview package passed: actual patch and plugin startup, two tabs, editable copies, input/save/reopen, Library return and reversible home.")
    end)
    if not ok then print("Device preview package failed: " .. tostring(failure)) end
    UIManager:quit(ok and 0 or 1)
end)
