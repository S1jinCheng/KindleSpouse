$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = Join-Path $projectRoot 'native/notebook-lab'
$privateRoot = Join-Path $projectRoot ('.test-data/notebook-lab-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $privateRoot | Out-Null
Add-Type -Path (Join-Path $projectRoot 'native/NativeCopy.cs')
function FindItem($Folder, [string]$Name) {
    return @($Folder.Items() | Where-Object { $actual = $_.ExtendedProperty('System.FileName'); if (!$actual) { $actual = $_.Name }; $actual -ceq $Name }) | Select-Object -First 1
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
    if (!$item -or !$item.IsFolder) { throw 'Diagnostic folder is unavailable.' }
    return $item.GetFolder
}
$shellApp = New-Object -ComObject Shell.Application
$devices = @($shellApp.Namespace(17).Items() | Where-Object { $_.Name -like 'Kindle*' })
if ($devices.Count -ne 1) { throw 'Exit KOReader and connect exactly one Kindle.' }
$root = @($devices[0].GetFolder.Items())[0].GetFolder
$extensions = FindItem $root 'extensions'
if (!$extensions -or !$extensions.IsFolder) { throw 'KUAL extensions folder is missing.' }
$local = $shellApp.Namespace($privateRoot)
$source = $shellApp.Namespace($sourceRoot)
$koreader = FindItem $root 'koreader'
if (!$koreader -or !$koreader.IsFolder) { throw 'KOReader is missing.' }
$plugins = FindItem $koreader.GetFolder 'plugins'
if (!$plugins -or !$plugins.IsFolder) { throw 'KOReader plugins folder is missing.' }
$targets = @(
    @{Folder=(EnsureFolder $extensions.GetFolder 'kindlespouse-notebook-lab'); Files=@('config.xml','menu.json','probe.sh'); Prefix='kual'},
    @{Folder=(EnsureFolder $plugins.GetFolder 'kindlespouse-notebook-lab.koplugin'); Files=@('main.lua','_meta.lua','probe.sh'); Prefix='koreader'}
)
foreach ($entry in $targets) {
    foreach ($name in $entry.Files) {
        $previous = FindItem $entry.Folder $name
        $key = $entry.Prefix + '-' + $name
        if ($previous) { [KindleNativeCopy]::CopyNamed($previous, $local.Self, ('before-' + $key)) }
        [KindleNativeCopy]::CopyNamed($source.ParseName($name), $entry.Folder.Self, $name)
        $written = FindItem $entry.Folder $name
        if (!$written) { throw 'Diagnostic file was not transferred.' }
        [KindleNativeCopy]::CopyNamed($written, $local.Self, ('verified-' + $key))
        if ((Get-FileHash -LiteralPath (Join-Path $privateRoot ('verified-' + $key)) -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $sourceRoot $name) -Algorithm SHA256).Hash) { throw 'Diagnostic transfer verification failed.' }
    }
}
@{installed=$true;verifiedFiles=6;entry='KOReader: Notebook 连接测试';existingNotebooksChanged=$false;existingKOReaderFilesChanged=$false} | ConvertTo-Json -Compress
