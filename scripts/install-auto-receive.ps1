param([string]$Package = (Join-Path $PSScriptRoot '../artifacts/KindleSpouse-AutoReceive-Update.zip'))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$staging = [IO.Path]::GetFullPath((Join-Path $projectRoot ('.test-data/auto-receive-install-' + [Guid]::NewGuid().ToString('N'))))
if (-not $staging.StartsWith(($projectRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid staging directory.' }
$packagePath = [IO.Path]::GetFullPath($Package)
$expected = (Get-Content -LiteralPath ($packagePath + '.sha256') -Raw).Trim()
if ((Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Update checksum mismatch.' }
$allowed = @('kindlespouse/kindlespouse-sync','kindlespouse/sync.sh','koreader/plugins/kindlespouse.koplugin/main.lua','koreader/plugins/kindlespouse.koplugin/home.lua','koreader/plugins/kindlespouse.koplugin/library.lua','koreader/plugins/kindlespouse.koplugin/shelf.lua','koreader/plugins/kindlespouse.koplugin/profile.lua')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($packagePath)
try {
    if ($archive.Entries.Count -ne $allowed.Count) { throw 'Expected exactly seven components.' }
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName -notin $allowed -or $entry.Length -gt 30MB) { throw 'Unexpected update component.' }
    }
} finally { $archive.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($packagePath, $staging)
Add-Type -Path (Join-Path $projectRoot 'native/NativeCopy.cs')
function FindItem($Folder, [string]$Name) {
    return @($Folder.Items() | Where-Object { $actual = $_.ExtendedProperty('System.FileName'); if ([string]::IsNullOrWhiteSpace($actual)) { $actual = $_.Name }; $actual -ceq $Name }) | Select-Object -First 1
}
function DeviceFolder($Folder, [string[]]$Parts) {
    foreach ($part in $Parts) {
        $item = FindItem $Folder $part
        if ($null -eq $item -or -not $item.IsFolder) { throw 'Required component directory is missing.' }
        $Folder = $item.GetFolder
    }
    return $Folder
}
$shellApp = New-Object -ComObject Shell.Application
$devices = @($shellApp.Namespace(17).Items() | Where-Object { $_.Name -like 'Kindle*' })
if ($devices.Count -ne 1) { throw 'Exit KOReader and connect exactly one Kindle.' }
$deviceRoot = @($devices[0].GetFolder.Items())[0].GetFolder
$component = DeviceFolder $deviceRoot @('kindlespouse')
foreach ($name in @('config.json','rclone.conf')) { if ($null -eq (FindItem $component $name)) { throw 'Existing device pairing is required.' } }
$verification = Join-Path $staging 'readback'
New-Item -ItemType Directory -Path $verification | Out-Null
$localFolder = $shellApp.Namespace($verification)
$count = 0
foreach ($relative in $allowed) {
    $parts = $relative.Split('/')
    $folder = DeviceFolder $deviceRoot $parts[0..($parts.Length - 2)]
    $targetName = $parts[-1]
    if ($relative -eq 'kindlespouse/kindlespouse-sync') { $targetName = 'kindlespouse-sync-next' }
    $file = Get-Item -LiteralPath (Join-Path $staging $relative)
    $previous = FindItem $folder $targetName
    if ($null -ne $previous) { [KindleNativeCopy]::CopyNamed($previous, $localFolder.Self, ('before-' + $count)) }
    [KindleNativeCopy]::CopyNamed($shellApp.Namespace($file.DirectoryName).ParseName($file.Name), $folder.Self, $targetName)
    $copied = FindItem $folder $targetName
    if ($null -eq $copied) { throw 'Component was not written.' }
    $verifiedName = 'verified-' + $count
    [KindleNativeCopy]::CopyNamed($copied, $localFolder.Self, $verifiedName)
    if ((Get-FileHash -LiteralPath (Join-Path $verification $verifiedName) -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw 'Component readback mismatch.' }
    $count++
}
@{ updated=$true; verifiedFiles=$count; credentialsReadOrChanged=$false; existingBooksChanged=$false; binaryStagedForSafeActivation=$true } | ConvertTo-Json -Compress
