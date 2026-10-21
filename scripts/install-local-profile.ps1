param([Parameter(Mandatory=$true)][string]$Package, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$staging = [IO.Path]::GetFullPath((Join-Path $projectRoot ('.test-data/local-profile-update-' + [Guid]::NewGuid().ToString('N'))))
if (-not $staging.StartsWith(($projectRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid staging directory.' }
$packagePath = [IO.Path]::GetFullPath($Package)
$expectedHash = (Get-Content -LiteralPath ($packagePath + '.sha256') -Raw).Trim()
if ($expectedHash -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Connection package checksum mismatch.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$allowed = @('kindlespouse/lan.json','kindlespouse/kindlespouse-sync-next','kindlespouse/sync.sh','koreader/plugins/kindlespouse.koplugin/main.lua','koreader/plugins/kindlespouse.koplugin/home.lua','koreader/plugins/kindlespouse.koplugin/library.lua','koreader/plugins/kindlespouse.koplugin/shelf.lua','koreader/plugins/kindlespouse.koplugin/profile.lua','INSTALL.txt')
$archive = [IO.Compression.ZipFile]::OpenRead($packagePath)
try {
    $seen = @{}
    $total = 0
    if ($archive.Entries.Count -gt ($allowed.Count + 4)) { throw 'Connection package has too many files.' }
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName
        $total += $entry.Length
        if ($total -gt 25MB -or $name.Contains('\') -or $name.StartsWith('/') -or $name.Contains(':') -or $name.Split('/') -contains '..' -or $name.Split('/') -contains '.') { throw 'Invalid connection package path.' }
        if ($name.EndsWith('/')) {
            if ($name -notin @('kindlespouse/','koreader/','koreader/plugins/','koreader/plugins/kindlespouse.koplugin/')) { throw 'Unexpected connection package directory.' }
            continue
        }
        if ($name -notin $allowed -or $seen.ContainsKey($name)) { throw 'Unexpected or duplicate connection package file.' }
        if ($name -eq 'kindlespouse/lan.json' -and $entry.Length -gt 8192) { throw 'Invalid connection configuration size.' }
        $seen[$name] = $true
    }
    if ($seen.Count -ne $allowed.Count) { throw 'Incomplete connection package.' }
} finally { $archive.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($packagePath, $staging)
$connection = Get-Content -LiteralPath (Join-Path $staging 'kindlespouse/lan.json') -Raw | ConvertFrom-Json
$parsedId = [Guid]::Empty
if ($connection.version -ne 1 -or -not [Guid]::TryParse($connection.deviceId, [ref]$parsedId) -or $connection.token -notmatch '^[a-f0-9]{64}$' -or $connection.certificateSha256 -notmatch '^[a-f0-9]{64}$' -or @($connection.urls).Count -lt 1 -or @($connection.urls).Count -gt 8) { throw 'Invalid connection configuration.' }
foreach ($endpoint in $connection.urls) {
    $uri = [Uri]$endpoint
    $address = [Net.IPAddress]::None
    if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/' -or -not [Net.IPAddress]::TryParse($uri.Host, [ref]$address)) { throw 'Invalid local endpoint.' }
    $octets = $address.GetAddressBytes()
    if ($octets.Length -ne 4 -or -not ($octets[0] -eq 10 -or ($octets[0] -eq 192 -and $octets[1] -eq 168) -or ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or $octets[0] -eq 127)) { throw 'Connection endpoint must be a private local address.' }
}
if ($ValidateOnly) { @{valid=$true;files=$allowed.Count;privateConfiguration=$true} | ConvertTo-Json -Compress; exit 0 }
Add-Type -Path (Join-Path $projectRoot 'native/NativeCopy.cs')
function ItemName($item) { $name = $item.ExtendedProperty('System.FileName'); if ([string]::IsNullOrWhiteSpace($name)) { return $item.Name }; return $name }
function FindItem($folder, $name) { return @($folder.Items() | Where-Object { (ItemName $_) -eq $name }) | Select-Object -First 1 }
function ExistingFolder($folder, [string[]]$parts) {
    foreach ($part in $parts) {
        $item = FindItem $folder $part
        if ($null -eq $item -or -not $item.IsFolder) { throw 'Existing KindleSpouse photo component is required; no files changed.' }
        $folder = $item.GetFolder
    }
    return $folder
}
$shell = New-Object -ComObject Shell.Application
$devices = @($shell.Namespace(17).Items() | Where-Object { $_.Name -like 'Kindle*' })
if ($devices.Count -ne 1) { throw 'Connect exactly one Kindle after exiting KOReader.' }
$root = @($devices[0].GetFolder.Items())[0].GetFolder
$component = ExistingFolder $root @('kindlespouse')
$plugin = ExistingFolder $root @('koreader','plugins','kindlespouse.koplugin')
$verify = Join-Path $staging 'readback'
New-Item -ItemType Directory -Path $verify | Out-Null
$local = $shell.Namespace($verify)
$preserved = @{}
$protected = @('config.json','rclone.conf','pause.requested','titles-pause.requested','profile-pause.requested','sync.lock','kindlespouse-sync')
foreach ($name in $protected) {
    $item = FindItem $component $name
    if ($null -eq $item) {
        if ($name -in @('config.json','rclone.conf','kindlespouse-sync')) { throw 'Existing pairing and component are required; no files changed.' }
        continue
    }
    [KindleNativeCopy]::CopyNamed($item, $local.Self, ('before-' + $name))
    $preserved[$name] = (Get-FileHash -LiteralPath (Join-Path $verify ('before-' + $name)) -Algorithm SHA256).Hash
}
$deviceConfig = Get-Content -LiteralPath (Join-Path $verify 'before-config.json') -Raw | ConvertFrom-Json
if ($deviceConfig.deviceId -ne $connection.deviceId) { throw 'This connection package belongs to a different Kindle; no files changed.' }
$count = 0
foreach ($relative in $allowed | Where-Object { $_ -ne 'INSTALL.txt' }) {
    $folder = if ($relative.StartsWith('kindlespouse/')) { $component } else { $plugin }
    $name = $relative.Split('/')[-1]
    $old = FindItem $folder $name
    $key = $count.ToString('D2') + '-' + $name
    if ($null -ne $old) { [KindleNativeCopy]::CopyNamed($old, $local.Self, ('original-' + $key)) }
    $sourcePath = [IO.Path]::GetFullPath((Join-Path $staging $relative))
    $source = $shell.Namespace([IO.Path]::GetDirectoryName($sourcePath)).ParseName([IO.Path]::GetFileName($sourcePath))
    [KindleNativeCopy]::CopyNamed($source, $folder.Self, $name)
    $copied = FindItem $folder $name
    if ($null -eq $copied) { throw 'Component write failed. Backups are preserved.' }
    [KindleNativeCopy]::CopyNamed($copied, $local.Self, ('verified-' + $key))
    if ((Get-FileHash -LiteralPath (Join-Path $verify ('verified-' + $key)) -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash) { throw 'Component readback mismatch. Backups are preserved.' }
    $count++
}
foreach ($name in $protected) {
    $item = FindItem $component $name
    if (-not $preserved.ContainsKey($name)) { if ($null -ne $item) { throw 'A protected device state changed during installation.' }; continue }
    if ($null -eq $item) { throw 'A protected device file disappeared during installation.' }
    [KindleNativeCopy]::CopyNamed($item, $local.Self, ('after-' + $name))
    if ((Get-FileHash -LiteralPath (Join-Path $verify ('after-' + $name)) -Algorithm SHA256).Hash -ne $preserved[$name]) { throw 'Personal configuration changed during update.' }
}
$report = @{updated=$true;verifiedFiles=$count;deviceIdentityMatched=$true;pairingPreserved=$true;pausePreserved=$true;activeBinaryPreserved=$true;existingBooksChanged=$false;binaryStagedForSafeActivation=$true}
$report | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $projectRoot '.test-data/local-profile-device-install.json') -Encoding utf8
$report | ConvertTo-Json -Compress
