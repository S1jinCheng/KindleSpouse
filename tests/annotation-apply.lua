local apply = dofile("native/companion/plugin/annotation_apply.lua").apply
local data = { annotations = { { text = "Quote", note = "Original", datetime = "Today", pos0 = "/p[1]", pos1 = "/p[2]", page = "/p[1]" } } }
local settings = {}
function settings:readSetting(key) return data[key] end
function settings:saveSetting(key, value) data[key] = value end
local job = { jobId = "one", operation = "edit", note = "Updated", expected = { text = "Quote", note = "Original", datetime = "Today", pos0 = "/p[1]", pos1 = "/p[2]" } }
assert(apply(settings, job) == "applied")
assert(data.annotations[1].note == "Updated")
assert(apply(settings, job) == "applied")
job.jobId = "two"
job.note = "Conflict"
assert(apply(settings, job) == "conflict")
assert(data.annotations[1].note == "Updated")
job.expected.note = "Updated"
job.operation = "delete"
assert(apply(settings, job) == "applied")
assert(#data.annotations == 0)
assert(apply(settings, job) == "applied")
print("Annotation apply: exact revision, conflict protection, deletion and idempotency passed")
