param([string]$Package = (Join-Path $PSScriptRoot '../artifacts/KindleSpouse-Device-Update.zip'))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$staging = [IO.Path]::GetFullPath((Join-Path $projectRoot ('.test-data/device-update-' + [Guid]::NewGuid().ToString('N'))))
if (-not $staging.StartsWith(($projectRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid staging directory.' }
$packagePath = [IO.Path]::GetFullPath($Package)
$expectedHash = (Get-Content -LiteralPath ($packagePath + '.sha256') -Raw).Trim()
if ((Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Update package checksum mismatch.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -Path (Join-Path $projectRoot 'native/NativeCopy.cs')
$archive = [IO.Compression.ZipFile]::OpenRead($packagePath)
try {
    $total = 0
    if ($archive.Entries.Count -gt 1000) { throw 'Update has too many files.' }
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName
        $total += $entry.Length
        if ($total -gt 500MB -or $name.Contains('\') -or $name.StartsWith('/') -or $name.Contains(':') -or $name.Split('/') -contains '..' -or $name.Split('/') -contains '.') { throw 'Invalid update package path.' }
        if ($name.EndsWith('/')) { continue }
        if ($name -notmatch '^(kindlespouse/(kindlespouse-sync|rclone|ca\.pem|sync\.sh|catalog\.sh|UPDATE\.txt|licenses/.+)|koreader/plugins/(kindlespouse|customisablesleepscreen)\.koplugin/.+|koreader/fonts/kindlespouse/[A-Za-z0-9-]+\.(otf|ttf))$') { throw 'Unexpected update file.' }
        if ($name -match '(?i)(^|/)(config\.json|rclone\.conf|pause\.requested|sleep-profile\.json)$') { throw 'Update must not contain personal configuration.' }
    }
} finally { $archive.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($packagePath, $staging)
function ItemName($item) { $name = $item.ExtendedProperty('System.FileName'); if ([string]::IsNullOrWhiteSpace($name)) { return $item.Name }; return $name }
function FindItem($folder, $name) { return @($folder.Items() | Where-Object { (ItemName $_) -eq $name }) | Select-Object -First 1 }
function DeviceFolder($root, [string[]]$parts) {
    $folder = $root
    foreach ($part in $parts) {
        $item = FindItem $folder $part
        if ($null -eq $item) {
            $folder.NewFolder($part)
            for ($attempt=0; $attempt -lt 30; $attempt++) {
                Start-Sleep -Milliseconds 200
                $item = FindItem $folder $part
                if ($null -ne $item) { break }
            }
        }
        if ($null -eq $item -or -not $item.IsFolder) { throw 'Cannot access component directory.' }
        $folder = $item.GetFolder
    }
    return $folder
}
$shell = New-Object -ComObject Shell.Application
$devices = @($shell.Namespace(17).Items() | Where-Object { $_.Name -like 'Kindle*' })
if ($devices.Count -ne 1) { throw 'Connect exactly one Kindle after exiting KOReader.' }
$root = @($devices[0].GetFolder.Items())[0].GetFolder
$component = DeviceFolder $root @('kindlespouse')
$verify = Join-Path $staging 'readback'
New-Item -ItemType Directory -Path $verify | Out-Null
$local = $shell.Namespace($verify)
$preserved = @{}
foreach ($name in @('config.json','rclone.conf','pause.requested')) {
    $item = FindItem $component $name
    if ($null -eq $item) { if ($name -ne 'pause.requested') { throw 'Existing pairing is required; no component changed.' }; continue }
    [KindleNativeCopy]::CopyNamed($item, $local.Self, ('before-' + $name))
    $preserved[$name] = (Get-FileHash -LiteralPath (Join-Path $verify ('before-' + $name)) -Algorithm SHA256).Hash
}
$files = Get-ChildItem -LiteralPath (Join-Path $staging 'kindlespouse'),(Join-Path $staging 'koreader') -Recurse -File
$count = 0
foreach ($file in $files) {
    $relative = $file.FullName.Substring($staging.Length + 1).Replace('\','/')
    $parts = $relative.Split('/')
    $name = $parts[-1]
    if ($relative -eq 'kindlespouse/kindlespouse-sync') { $name = 'kindlespouse-sync-next' }
    $folder = DeviceFolder $root $parts[0..($parts.Length-2)]
    $key = $count.ToString('D4') + '-' + $name
    $old = FindItem $folder $name
    if ($null -ne $old) { [KindleNativeCopy]::CopyNamed($old, $local.Self, ('original-' + $key)) }
    [KindleNativeCopy]::CopyNamed($shell.Namespace($file.DirectoryName).ParseName($file.Name), $folder.Self, $name)
    $copied = FindItem $folder $name
    if ($null -eq $copied) { throw 'A component was not written. Backups are preserved.' }
    [KindleNativeCopy]::CopyNamed($copied, $local.Self, ('verified-' + $key))
    if ((Get-FileHash -LiteralPath (Join-Path $verify ('verified-' + $key)) -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw 'Component readback mismatch. Backups are preserved.' }
    $count++
}
foreach ($name in $preserved.Keys) {
    [KindleNativeCopy]::CopyNamed((FindItem $component $name), $local.Self, ('after-' + $name))
    if ((Get-FileHash -LiteralPath (Join-Path $verify ('after-' + $name)) -Algorithm SHA256).Hash -ne $preserved[$name]) { throw 'Personal configuration changed during update.' }
}
@{ updated=$true; verifiedFiles=$count; pairingPreserved=$true; existingBooksChanged=$false; binaryStagedForSafeActivation=$true } | ConvertTo-Json -Compress
