local Device = require("device")
local UIManager = require("ui/uimanager")
local Geom = require("ui/geometry")
local Embedded = {}

function Embedded.new(directory)
    local load = assert(loadfile(directory .. "/loader.lua"))()(directory)
    load("pluginicons")()
    return setmetatable({ load = load }, { __index = Embedded })
end

function Embedded:open(name, folder, template, companion)
    if self.editor and not self.editor.closed then return self.editor end
    local Library = self.load("library")
    local Document = self.load("document")
    local Notebook = self.load("notebook")
    local filename = Library.abs((folder ~= "" and folder .. "/" or "") .. name .. ".scribe")
    local document = Document:new(filename)
    if require("libs/libkoreader-lfs").attributes(filename, "mode") == "file" then
        assert(document:load(), "Notebook cannot be decoded")
    elseif template then
        document:setTemplate(template)
    end
    local editor
    editor = Notebook:new {
        document = document,
        title = name,
        on_request = function(_, kind)
            if kind == "library" then editor:_close() end
        end,
        on_closed = function()
            self.editor = nil
            if self.gallery and not self.gallery.closed then self.gallery:_rebuild() end
            UIManager:setDirty(companion.ui, "full")
        end,
    }
    self.editor = editor
    UIManager:show(editor, "full")
    return editor
end

function Embedded:body(companion, height)
    local directory = assert(debug.getinfo(1, "S").source:match("^@(.+)/[^/]+$"))
    return assert(loadfile(directory .. "/gallery.lua"))()(self, companion, height)
end

function Embedded:install(Home)
    local instance = self
    Home.notebook = function(companion, height) return instance:body(companion, height) end
    local original_layout = Home.layout
    Home.layout = function(ui, companion)
        if instance.gallery then
            instance.folder = instance.gallery.folder
            instance.query = instance.gallery.query
            if not instance.gallery.closed then instance.gallery:onCloseWidget() end
            instance.gallery = nil
        end
        original_layout(ui, companion)
        if instance.gallery then ui.title_bar:setSubTitle(string.format("%d 本笔记", #instance.gallery.items)) end
    end
    local original_toggle = Home.toggle
    Home.toggle = function(companion)
        if instance.gallery and not instance.gallery.closed then instance.gallery:onCloseWidget() end
        instance.gallery = nil
        return original_toggle(companion)
    end
end

return Embedded
