$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$staging = [IO.Path]::GetFullPath((Get-Content -LiteralPath (Join-Path $projectRoot '.test-data/notebook-preview-latest.txt') -Raw).Trim())
if (!$staging.StartsWith((Join-Path $projectRoot '.test-data/notebook-preview-'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid staging directory.' }
$verified = Get-Content -LiteralPath (Join-Path $staging 'verified.json') -Raw | ConvertFrom-Json
if (!$verified.verified -or !$verified.sourceFilesUnchanged) { throw 'Computer acceptance must pass before installation.' }
$filesRoot = Join-Path $staging 'files'
$files = @(Get-ChildItem -LiteralPath $filesRoot -Recurse -File)
$total = 0
$manifest = @()
foreach ($file in $files) {
    $relative = $file.FullName.Substring($filesRoot.Length + 1).Replace('\','/')
    $total += $file.Length
    if ($files.Count -gt 500 -or $total -gt 300MB -or $relative.Split('/') -contains '..' -or $relative.Contains(':') -or $relative -notmatch '^koreader/(kindlespouse-notebook/.+|icons/notebook\.[^/]+\.svg|plugins/kindlespouse\.koplugin/(main\.lua|home\.lua|library\.lua|shelf\.lua|profile\.lua|_meta\.lua|annotation_apply\.lua|LICENSE)|patches/2-kindlespouse-notebook-preview\.lua|notebook/Scribe 可编辑副本/[^/]+\.scribe)$') { throw 'Unexpected preview component.' }
    $manifest += @{relative=$relative;bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
Add-Type -Path (Join-Path $projectRoot 'native/NativeCopy.cs')
function FindItem($Folder, [string]$Name) {
    return @($Folder.Items() | Where-Object { $actual = $_.ExtendedProperty('System.FileName'); if (!$actual) { $actual = $_.Name }; $actual -ceq $Name }) | Select-Object -First 1
}
function ExistingFolder($Folder, [string[]]$Parts) {
    foreach ($part in $Parts) {
        $item = FindItem $Folder $part
        if (!$item -or !$item.IsFolder) { return $null }
        $Folder = $item.GetFolder
    }
    return $Folder
}
function EnsureFolder($Folder, [string]$Name) {
    $item = FindItem $Folder $Name
    if (!$item) {
        $Folder.NewFolder($Name)
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 200
            $item = FindItem $Folder $Name
            if ($item) { break }
        }
    }
    if (!$item -or !$item.IsFolder) { throw 'Preview destination is unavailable.' }
    return $item.GetFolder
}
$shellApp = New-Object -ComObject Shell.Application
$devices = @($shellApp.Namespace(17).Items() | Where-Object { $_.Name -like 'Kindle*' })
if ($devices.Count -ne 1) { throw 'Exit KOReader and connect exactly one Kindle.' }
$root = @($devices[0].GetFolder.Items())[0].GetFolder
$koreader = ExistingFolder $root @('koreader')
$plugins = ExistingFolder $root @('koreader','plugins')
if (!$koreader -or !$plugins) { throw 'Existing KOReader installation is required.' }
if (ExistingFolder $root @('koreader','notebook','Scribe 可编辑副本')) { throw 'Editable copy folder already exists. Existing edits were preserved; no device files changed.' }
$backup = Join-Path $staging 'backup'
$readback = Join-Path $staging 'readback'
New-Item -ItemType Directory -Path $backup,$readback | Out-Null
$backupFolder = $shellApp.Namespace($backup)
$readbackFolder = $shellApp.Namespace($readback)
$version = FindItem $koreader 'git-rev'
if (!$version) { throw 'KOReader version is unavailable.' }
[KindleNativeCopy]::CopyNamed($version, $backupFolder.Self, 'git-rev')
if ((Get-Content -LiteralPath (Join-Path $backup 'git-rev') -Raw).Trim() -cne 'v2026.07.1') { throw 'This preview requires KOReader v2026.07.1; no device files changed.' }
$settings = FindItem $koreader 'settings.reader.lua'
if (!$settings) { throw 'Existing KOReader settings are required.' }
[KindleNativeCopy]::CopyNamed($settings, $backupFolder.Self, 'settings.reader.lua')
$settingsHash = (Get-FileHash -LiteralPath (Join-Path $backup 'settings.reader.lua') -Algorithm SHA256).Hash
$groups = @(
    @{Parent=$koreader;Name='kindlespouse-notebook';Relative='koreader/kindlespouse-notebook';Key='engine'},
    @{Parent=$koreader;Name='icons';Relative='koreader/icons';Key='icons'},
    @{Parent=$plugins;Name='kindlespouse.koplugin';Relative='koreader/plugins/kindlespouse.koplugin';Key='companion'}
)
foreach ($group in $groups) {
    $old = FindItem $group.Parent $group.Name
    if ($old) { [KindleNativeCopy]::CopyNamed($old, $backupFolder.Self, ('before-' + $group.Key)) }
}
$patches = ExistingFolder $root @('koreader','patches')
if ($patches) {
    $previousPatch = FindItem $patches '2-kindlespouse-notebook-preview.lua'
    if ($previousPatch) { [KindleNativeCopy]::CopyNamed($previousPatch, $backupFolder.Self, 'before-preview.lua') }
}
[IO.File]::WriteAllText((Join-Path $staging 'install-manifest.json'), (@{files=$manifest;notebooks=$verified.imported;bytes=$total} | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$notebookFolder = EnsureFolder $koreader 'notebook'
$groups += @{Parent=$notebookFolder;Name='Scribe 可编辑副本';Relative='koreader/notebook/Scribe 可编辑副本';Key='notebooks'}
foreach ($group in $groups) {
    Write-Host ('Installing ' + $group.Key)
    $sourcePath = Join-Path $filesRoot $group.Relative
    $sourceItem = $shellApp.Namespace((Split-Path -Parent $sourcePath)).ParseName((Split-Path -Leaf $sourcePath))
    [KindleNativeCopy]::CopyNamed($sourceItem, $group.Parent.Self, $group.Name)
    $installed = FindItem $group.Parent $group.Name
    if (!$installed -or !$installed.IsFolder) { throw 'Preview folder transfer failed.' }
    [KindleNativeCopy]::CopyNamed($installed, $readbackFolder.Self, $group.Key)
    foreach ($entry in @($manifest | Where-Object { $_.relative.StartsWith($group.Relative + '/', [StringComparison]::Ordinal) })) {
        $suffix = $entry.relative.Substring($group.Relative.Length + 1)
        $filename = Join-Path (Join-Path $readback $group.Key) $suffix
        if (!(Test-Path -LiteralPath $filename -PathType Leaf) -or (Get-Item -LiteralPath $filename).Length -ne $entry.bytes -or (Get-FileHash -LiteralPath $filename -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw 'Preview readback verification failed; activation patch has not been installed.' }
    }
}
$patches = EnsureFolder $koreader 'patches'
$patchSource = $shellApp.Namespace((Join-Path $filesRoot 'koreader/patches')).ParseName('2-kindlespouse-notebook-preview.lua')
[KindleNativeCopy]::CopyNamed($patchSource, $patches.Self, '2-kindlespouse-notebook-preview.lua')
$patch = FindItem $patches '2-kindlespouse-notebook-preview.lua'
[KindleNativeCopy]::CopyNamed($patch, $readbackFolder.Self, 'preview.lua')
if ((Get-FileHash -LiteralPath (Join-Path $readback 'preview.lua') -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $filesRoot 'koreader/patches/2-kindlespouse-notebook-preview.lua') -Algorithm SHA256).Hash) { throw 'Preview activation patch readback failed.' }
[KindleNativeCopy]::CopyNamed((FindItem $koreader 'settings.reader.lua'), $readbackFolder.Self, 'settings.reader.lua')
if ((Get-FileHash -LiteralPath (Join-Path $readback 'settings.reader.lua') -Algorithm SHA256).Hash -ne $settingsHash) { throw 'Existing KOReader settings changed during installation.' }
$inputs = Get-Content -LiteralPath (Join-Path $staging 'inputs.json') -Raw | ConvertFrom-Json
$nativeRoot = ExistingFolder $root @('.notebooks')
$originalVerification = Join-Path $staging 'original-readback'
New-Item -ItemType Directory -Path $originalVerification | Out-Null
$originalFolder = $shellApp.Namespace($originalVerification)
$index = 0
foreach ($input in $inputs.notebooks) {
    $native = ExistingFolder $nativeRoot @($input.identity)
    if (!$native) { throw 'Original notebook is unavailable for verification.' }
    [KindleNativeCopy]::CopyNamed((FindItem $native 'nbk'), $originalFolder.Self, ($index.ToString() + '.nbk'))
    if ((Get-FileHash -LiteralPath (Join-Path $originalVerification ($index.ToString() + '.nbk')) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $input.sha256) { throw 'Original notebook changed; investigate before using the preview.' }
    $index++
}
$result = @{installed=$true;verifiedFiles=$manifest.Count;editableNotebookCopies=$verified.imported;pages=$verified.pages;originalNotebooksVerifiedUnchanged=$index;settingsPreserved=$true;backup=$backup;deviceNotebookFolder='koreader/notebook/Scribe 可编辑副本'}
[IO.File]::WriteAllText((Join-Path $staging 'installed.json'), ($result | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
$result | ConvertTo-Json -Compress
