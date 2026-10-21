local width, covers, images = 200, 0, 0
local function buffer(w, h)
    local value = { w = w, h = h }
    function value:getWidth() assert(not self.freed); return self.w end
    function value:getHeight() assert(not self.freed); return self.h end
    function value:blitFrom(source) assert(not self.freed and not source.freed) end
    function value:paintRect() assert(not self.freed) end
    function value:paintCircle() assert(not self.freed) end
    function value:copy() assert(not self.freed); return buffer(self.w, self.h) end
    function value:free() assert(not self.freed, "blitbuffer freed twice"); self.freed = true end
    return value
end
local widget = {}
function widget:extend() return self end
function widget:new(value)
    value = value or {}
    function value:getSize() return { w = 10, h = 10 } end
    function value:free() end
    function value:paintTo() end
    return value
end
package.preload["ui/widget/widget"] = function() return widget end
package.preload["ui/widget/textboxwidget"] = function() return widget end
package.preload["ui/widget/textwidget"] = function() return widget end
package.preload["ui/geometry"] = function() return widget end
package.preload["ui/font"] = function() return { getFace = function() return {} end } end
package.preload["device"] = function() return { screen = { getWidth = function() return width end, getHeight = function() return 300 end, scaleBySize = function() return 1 end } } end
package.preload["libs/libkoreader-lfs"] = function() return { attributes = function(file) return file and { size = 100, modification = 1 } end } end
package.preload["ffi/blitbuffer"] = function() return { new = buffer } end
package.preload["ui/renderimage"] = function() return {
    renderImageFile = function() images = images + 1; return buffer(256, 256) end,
    scaleBlitBuffer = function(_, source, w, h, release) if release then source:free() end; return buffer(w, h) end,
} end
local reader = { document = { file = "Books/First.epub", getCoverPageImage = function() covers = covers + 1; return buffer(200, 300) end } }
local profile = { displayName = "Reader", avatar = "R", avatarHash = string.rep("a", 64) }
local preset = dofile("native/sleep-cover/preset.lua")
preset.prepare(reader, nil, profile)
preset.prepare(reader, nil, profile)
assert(covers == 1 and images == 1, "ready event did not reuse prepared images")
for _, progress in ipairs({ 0.2, 0.6, 0.9 }) do
    local cover = preset.build(reader, nil, { title = "Book", progress = progress }, profile, { duration = 120, streak = 2 })
    cover:paintTo(buffer(width, 300), 0, 0)
    cover:free()
    cover:free()
end
assert(covers == 1 and images == 1, "changing progress decoded static images again")
profile.avatarHash = string.rep("b", 64)
preset.prepare(reader, nil, profile)
assert(covers == 1 and images == 2, "new avatar did not invalidate only the photo")
reader.document.file = "Books/Second.epub"
preset.prepare(reader, nil, profile)
assert(covers == 2 and images == 2, "book change did not invalidate only the book cover")
width = 300
preset.prepare(reader, nil, profile)
assert(covers == 3 and images == 3, "screen size did not invalidate scaled assets")
print("Sleep assets: prewarming, progress-only reuse, avatar/book/size invalidation and widget ownership passed.")
