$ErrorActionPreference = 'Stop'
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../native/DeviceBridge.ps1'), [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Device bridge does not parse.' }
foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($function.Extent.Text))
}
$diskRoot = [pscustomobject]@{ Label='disk-root' }
$disk = [pscustomobject]@{Path='Z:\';GetFolder=$diskRoot}
if ((Get-StorageFolder $disk).Label -ne 'disk-root') { throw 'Mass storage root was not selected.' }
$mtpRoot = [pscustomobject]@{Label='mtp-root'}
$mtpStorage = [pscustomobject]@{IsFolder=$true;GetFolder=$mtpRoot}
$mtpContainer = [pscustomobject]@{Storage=$mtpStorage}
$mtpContainer | Add-Member -MemberType ScriptMethod -Name Items -Value { return @($this.Storage) }
$mtp = [pscustomobject]@{Path='::{generated-mtp-device}';GetFolder=$mtpContainer}
if ((Get-StorageFolder $mtp).Label -ne 'mtp-root') { throw 'MTP storage root was not selected.' }
foreach ($relative in @('documents/book.epub','.notebooks/nbk','koreader/settings.reader.lua','kindlespouse/pause.requested','../kindlespouse/rclone','kindlespouse/../../file','koreader/plugins/other.koplugin/main.lua','kindlespouse\rclone')) {
    if (Test-ComponentPath $relative $true) { throw 'Unsafe component path accepted.' }
}
if (Test-ComponentPath 'kindlespouse/rclone.conf' $false) { throw 'Public updates must not replace credentials.' }
foreach ($relative in @('kindlespouse/config.json','kindlespouse/rclone.conf','kindlespouse/lan.json','koreader/plugins/kindlespouse.koplugin/main.lua','koreader/fonts/kindlespouse/Font.otf')) {
    if (-not (Test-ComponentPath $relative $true)) { throw 'Valid component path rejected.' }
}
@{passed=$true;massStorage=$true;mtpStorage=$true;unsafePathsRejected=$true;credentialsProtected=$true} | ConvertTo-Json -Compress
