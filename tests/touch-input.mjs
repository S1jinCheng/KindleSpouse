import {mkdir,mkdtemp,readdir,writeFile} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import path from 'node:path'
await mkdir('.test-data', { recursive: true })
const root=await mkdtemp(path.resolve('.test-data/touch-input-'))
const runtime=path.resolve('native/tools/koreader/squashfs-root/usr/lib/koreader')
const linux=value=>`/mnt/${value[0].toLowerCase()}/${value.slice(3).replaceAll('\\','/')}`
await mkdir(path.join(root,'patches'))
await mkdir(path.join(root,'books'))
await writeFile(path.join(root,'books','fixture.txt'),'Synthetic keyboard audit fixture')
const disabled=(await readdir(path.join(runtime,'plugins'))).filter(name=>name.endsWith('.koplugin')).map(name=>`["${name.replace('.koplugin','')}"]=true`).join(',')
await writeFile(path.join(root,'settings.reader.lua'),`return {language="en",last_migration_date=20260701,quickstart_shown_version=99999999,start_with="filemanager",disable_network_connection=true,auto_suspend_timeout_seconds=0,plugins_disabled={${disabled}}}`)
await writeFile(path.join(root,'patches','2-keyboard-proof.lua'),`
local UIManager = require("ui/uimanager")
local Device = require("device")
local InputDialog = require("ui/widget/inputdialog")
UIManager:tickAfterNext(function()
UIManager:scheduleIn(1, function()
 local ok, error = pcall(function()
  Device.hasKeyboard = function() return true end
  G_reader_settings:delSetting("virtual_keyboard_enabled")
  local hidden = InputDialog:new {title="Synthetic search",input="",buttons={}}
  UIManager:show(hidden)
  hidden:onShowKeyboard()
  assert(not hidden:isKeyboardVisible(), "Expected false hardware-keyboard detection to hide the keyboard")
  UIManager:close(hidden)
  package.path = "${linux(process.cwd())}/native/companion/plugin/?.lua;" .. package.path
  Device.isKindle = function() return true end
  Device.isTouchDevice = function() return true end
  require("touch_input").prepare()
  local shown = InputDialog:new {title="Synthetic search",input="",buttons={}}
  UIManager:show(shown)
  shown:onShowKeyboard()
  assert(shown:isKeyboardVisible(), "Expected explicit software-keyboard preference to show the keyboard")
  shown._input_widget:onTextInput("中文书名")
  assert(shown:getInputText()=="中文书名", "Expected Unicode text entry to work")
  UIManager:close(shown)
  print("TOUCH INPUT ACCEPTANCE PASSED: false keyboard detection hides input; explicit virtual keyboard shows; Unicode text accepted")
 end)
 if not ok then print("TOUCH INPUT ACCEPTANCE FAILED: "..tostring(error)) end
 UIManager:quit(ok and 0 or 1)
end)
end)
`)
const child=spawn('wsl.exe',['-d','Ubuntu','--cd',linux(runtime),'--exec','env','SDL_VIDEODRIVER=dummy','SDL_AUDIODRIVER=dummy',`XDG_DATA_HOME=${linux(root)}`,`KO_HOME=${linux(root)}`,'EMULATE_READER_W=1860','EMULATE_READER_H=2480','EMULATE_READER_DPI=300','LD_LIBRARY_PATH=libs','./luajit','reader.lua',linux(path.join(root,'books'))],{windowsHide:true})
let output=''
child.stdout.on('data',chunk=>output+=chunk)
child.stderr.on('data',chunk=>output+=chunk)
const timer=setTimeout(()=>child.kill(),30000)
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
clearTimeout(timer)
await writeFile(path.join(root,'runtime.log'),output)
console.log(JSON.stringify({code,root,result:output.split('\n').filter(line=>line.includes('TOUCH INPUT ACCEPTANCE'))}))
if (code !== 0 || !output.includes("TOUCH INPUT ACCEPTANCE PASSED")) throw new Error(output.slice(-2500))
