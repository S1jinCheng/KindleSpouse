local calls = 0
package.loaded["ui/widget/booklist"] = { getBookInfo = function() return {} end }
package.loaded.readcollection = {}
package.loaded["ui/uimanager"] = {}
package.loaded.device = { screen = {} }
package.loaded.util = {}
local Library = dofile("native/companion/plugin/library.lua")
Library.cache = {}
Library.catalog = function() return Library.cache end
local ui = { bookinfo = { getDocProps = function(_, _, _, no_open_document)
    assert(no_open_document == true, "Startup must not open uncached documents")
    calls = calls + 1
    return {}
end } }
for index = 1, 1000 do
    local item = Library.record(ui, { path = "/books/" .. index .. ".pdf", text = "Book " .. index,
        attr = { size = 100000000, modification = 1, change = 1 } }, "/books", {})
    assert(item.kindlespouse.title == "Book " .. index)
end
assert(calls == 1000)
Library.cache["/books/cached.epub"] = { size = 1, modified = 1, title = "Cached title", author = "Cached author" }
local item = Library.record(ui, { path = "/books/cached.epub", text = "cached.epub", attr = { size = 1, modification = 1 } }, "/books", {})
assert(item.kindlespouse.title == "Cached title" and item.kindlespouse.author == "Cached author")
print("Library startup passed: 1000 uncached documents enumerated without document opens; cached metadata retained.")
