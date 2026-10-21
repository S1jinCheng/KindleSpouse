param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Get-ItemFilename($item) {
    $name = $item.ExtendedProperty('System.FileName')
    if ([string]::IsNullOrWhiteSpace($name)) { return $item.Name }
    return $name
}
function Get-DeviceId($item) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($item.Path)))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}
function Get-FileSha256([string]$filename) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($filename)
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Get-DeviceFiles($folder, [string]$relative, $result) {
    foreach ($item in @($folder.Items())) {
        $name = Get-ItemFilename $item
        $childRelative = if ($relative) { $relative + '/' + $name } else { $name }
        if ($item.IsFolder) { Get-DeviceFiles $item.GetFolder $childRelative $result }
        else { $result.Add([pscustomobject]@{ relative=$childRelative; bytes=[long]$item.ExtendedProperty('System.Size') }) }
    }
}
function Get-ChildFolder($folder, [string]$name) {
    return @($folder.Items() | Where-Object { $_.IsFolder -and (Get-ItemFilename $_) -eq $name }) | Select-Object -First 1
}
function Ensure-ChildFolder($folder, [string]$name) {
    $item = Get-ChildFolder $folder $name
    if ($null -eq $item) {
        $folder.NewFolder($name)
        for ($attempt=0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 200
            $item = Get-ChildFolder $folder $name
            if ($null -ne $item) { break }
        }
    }
    if ($null -eq $item) { throw 'Cannot create Books/Inbox on the device.' }
    return $item.GetFolder
}
function Get-StorageFolder($device) {
    if ($device.Path -match '^[A-Za-z]:\\?$') { return $device.GetFolder }
    $storage = @($device.GetFolder.Items())[0]
    if ($null -eq $storage -or -not $storage.IsFolder) { throw 'Kindle storage is unavailable.' }
    return $storage.GetFolder
}
function Find-RelativeItem($root, [string]$relative) {
    $parts = $relative.Split('/')
    $folder = $root
    for ($index=0; $index -lt $parts.Length; $index++) {
        $item = @($folder.Items() | Where-Object { (Get-ItemFilename $_) -eq $parts[$index] }) | Select-Object -First 1
        if ($null -eq $item) { return $null }
        if ($index -eq $parts.Length - 1) { return $item }
        if (-not $item.IsFolder) { return $null }
        $folder = $item.GetFolder
    }
}
function Read-DeviceText($root, [string]$relative, [string]$scratch) {
    $item = Find-RelativeItem $root $relative
    if ($null -eq $item -or $item.IsFolder) { return $null }
    if ([long]$item.ExtendedProperty('System.Size') -gt 2097152) { throw 'Device metadata is too large.' }
    $name = [Guid]::NewGuid().ToString('N') + '.json'
    [KindleNativeCopy]::CopyNamed($item, $shell.Namespace($scratch).Self, $name)
    $filename = Join-Path $scratch $name
    try { return [IO.File]::ReadAllText($filename) } finally { Remove-Item -LiteralPath $filename -Force }
}
function Test-ComponentPath([string]$relative, [bool]$credentials) {
    if ($relative.Contains('\')) { return $false }
    foreach ($part in $relative.Split('/')) {
        if ($part -in @('', '.', '..') -or $part -notmatch '^[a-zA-Z0-9_. -]+$') { return $false }
    }
    if ($credentials -and $relative -match '^kindlespouse/(config\.json|rclone\.conf|lan\.json)$') { return $true }
    return $relative -match '^kindlespouse/(kindlespouse-sync|rclone|ca\.pem|catalog\.sh|sync\.sh|component-manifest\.json)$|^kindlespouse/licenses/|^koreader/plugins/(kindlespouse|customisablesleepscreen)\.koplugin/|^koreader/fonts/kindlespouse/'
}
function Get-ComponentFolder($root, [string]$relative) {
    $parts = $relative.Split('/')
    $folder = $root
    for ($index=0; $index -lt $parts.Length - 1; $index++) { $folder = Ensure-ChildFolder $folder $parts[$index] }
    return $folder
}
function Copy-LocalComponent([string]$filename, $root, [string]$relative) {
    $folder = Get-ComponentFolder $root $relative
    $source = $shell.Namespace([IO.Path]::GetDirectoryName($filename)).ParseName([IO.Path]::GetFileName($filename))
    [KindleNativeCopy]::CopyNamed($source, $folder.Self, ($relative.Split('/')[-1]))
}
try {
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
    $shell = New-Object -ComObject Shell.Application
    $devices = @($shell.Namespace(17).Items() | Where-Object { $_.Name -like 'Kindle*' })
    if ($payload.action -eq 'list') {
        $result = @($devices | ForEach-Object {
            $storage = (Get-StorageFolder $_).Self
            [pscustomobject]@{ id=(Get-DeviceId $_); name=($_.Name -replace '\s+G[0-9A-Z]+$', ''); freeBytes=$storage.ExtendedProperty('System.FreeSpace'); capacityBytes=$storage.ExtendedProperty('System.Capacity') }
        })
        @{ devices=$result } | ConvertTo-Json -Depth 6 -Compress
        exit 0
    }
    if ($payload.action -notin @('upload','export','export-notes','export-titles','inspect-companion','install-companion')) { throw 'Unknown operation.' }
    $device = @($devices | Where-Object { (Get-DeviceId $_) -eq $payload.deviceId }) | Select-Object -First 1
    if ($null -eq $device) { throw 'Kindle is not accessible. Save and exit KOReader, then reconnect USB.' }
    if ($payload.action -eq 'inspect-companion') {
        Add-Type -Path (Join-Path $PSScriptRoot 'NativeCopy.cs')
        $root = Get-StorageFolder $device
        $scratch = Join-Path ([IO.Path]::GetTempPath()) ('KindleSpouse-Inspect-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $scratch | Out-Null
        try {
            $reader = Find-RelativeItem $root 'koreader/reader.lua'
            $version = Read-DeviceText $root 'koreader/git-rev' $scratch
            $configuration = Read-DeviceText $root 'kindlespouse/config.json' $scratch
            $component = Read-DeviceText $root 'kindlespouse/component-manifest.json' $scratch
            $paired = if ($configuration) { ($configuration | ConvertFrom-Json).deviceId } else { $null }
            $revision = if ($component) { ($component | ConvertFrom-Json).revision } else { $null }
            @{readerInstalled=($null -ne $reader);readerVersion=($(if ($version) { $version.Trim() } else { $null }));pairedDeviceId=$paired;hasCredential=($null -ne (Find-RelativeItem $root 'kindlespouse/rclone.conf'));revision=$revision} | ConvertTo-Json -Compress
        } finally { Remove-Item -LiteralPath $scratch -Force }
        exit 0
    }
    if ($payload.action -eq 'install-companion') {
        Add-Type -Path (Join-Path $PSScriptRoot 'NativeCopy.cs')
        $root = Get-StorageFolder $device
        if ($null -eq (Find-RelativeItem $root 'koreader/reader.lua')) { throw 'Install KOReader before installing KindleSpouse components.' }
        $sourceRoot = [IO.Path]::GetFullPath($payload.directory).TrimEnd('\')
        $backupRoot = [IO.Path]::GetFullPath($payload.backup).TrimEnd('\')
        $plan = Get-Content -LiteralPath $payload.manifest -Raw | ConvertFrom-Json
        if ($plan.version -ne 1 -or @($plan.files).Count -lt 3 -or @($plan.files).Count -gt 2000) { throw 'Invalid component manifest.' }
        $seen = @{}
        foreach ($file in $plan.files) {
            if (-not (Test-ComponentPath $file.relative ([bool]$plan.credentials)) -or $seen.ContainsKey($file.relative.ToLowerInvariant())) { throw 'Invalid or duplicate component path.' }
            $seen[$file.relative.ToLowerInvariant()] = $true
            $local = [IO.Path]::GetFullPath((Join-Path $sourceRoot $file.relative.Replace('/', '\')))
            if (-not $local.StartsWith($sourceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Component path escapes package.' }
            $info = Get-Item -LiteralPath $local
            if ($info.PSIsContainer -or $info.Length -ne $file.bytes -or $info.Length -gt 209715200 -or $file.sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileSha256 $local) -ne $file.sha256) { throw 'Component checksum mismatch.' }
            if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Component contains a filesystem link.' }
            $cursor = $info.Directory
            while ($cursor -and $cursor.FullName.StartsWith($sourceRoot, [StringComparison]::OrdinalIgnoreCase)) {
                if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Component contains a filesystem link.' }
                $cursor = $cursor.Parent
            }
        }
        $scratch = Join-Path $sourceRoot '.readback'
        New-Item -ItemType Directory -Path $scratch -Force | Out-Null
        $saved = [Collections.Generic.List[object]]::new()
        $count = 0
        try {
            foreach ($file in @($plan.files | Where-Object { $_.relative -in @('kindlespouse/config.json','kindlespouse/rclone.conf') })) {
                $existing = Find-RelativeItem $root $file.relative
                if ($existing) {
                    $name = [Guid]::NewGuid().ToString('N')
                    [KindleNativeCopy]::CopyNamed($existing, $shell.Namespace($scratch).Self, $name)
                    $filename = Join-Path $scratch $name
                    if ((Get-FileSha256 $filename) -ne $file.sha256) { throw 'Existing device authorization differs; installation has not started.' }
                    Remove-Item -LiteralPath $filename -Force
                }
            }
            foreach ($file in $plan.files) {
                $local = Join-Path $sourceRoot $file.relative.Replace('/', '\')
                $existing = Find-RelativeItem $root $file.relative
                if ($existing -and $existing.IsFolder) { throw 'A component path is a folder on the device.' }
                if ($existing) {
                    $savePath = Join-Path $backupRoot $file.relative.Replace('/', '\')
                    $parent = [IO.Path]::GetDirectoryName($savePath)
                    New-Item -ItemType Directory -Path $parent -Force | Out-Null
                    $temporary = [Guid]::NewGuid().ToString('N')
                    [KindleNativeCopy]::CopyNamed($existing, $shell.Namespace($scratch).Self, $temporary)
                    $copy = Join-Path $scratch $temporary
                    if ((Get-Item -LiteralPath $copy).Length -ne [long]$existing.ExtendedProperty('System.Size')) { throw 'Cannot back up existing device component.' }
                    if ((Get-FileSha256 $copy) -eq $file.sha256) { Remove-Item -LiteralPath $copy -Force; $count++; @{progress=$count;total=@($plan.files).Count} | ConvertTo-Json -Compress; continue }
                    if ($file.relative -in @('kindlespouse/config.json','kindlespouse/rclone.conf')) { throw 'Existing device authorization differs; it has not been overwritten.' }
                    if (-not (Test-Path -LiteralPath $savePath)) { Copy-Item -LiteralPath $copy -Destination $savePath }
                    $saved.Add([pscustomobject]@{relative=$file.relative;path=$copy})
                }
                Copy-LocalComponent $local $root $file.relative
                $uploaded = Find-RelativeItem $root $file.relative
                if ($null -eq $uploaded) { throw 'Device component is missing after upload.' }
                $verifyName = [Guid]::NewGuid().ToString('N')
                [KindleNativeCopy]::CopyNamed($uploaded, $shell.Namespace($scratch).Self, $verifyName)
                $verifyPath = Join-Path $scratch $verifyName
                if ((Get-FileSha256 $verifyPath) -ne $file.sha256) { throw 'Device component readback verification failed.' }
                Remove-Item -LiteralPath $verifyPath -Force
                $count++
                @{progress=$count;total=@($plan.files).Count} | ConvertTo-Json -Compress
            }
            @{verified=$true;files=$count} | ConvertTo-Json -Compress
        } catch {
            $failure = $_.Exception.Message
            $restoreFailed = $false
            for ($index=$saved.Count-1; $index -ge 0; $index--) {
                try { Copy-LocalComponent $saved[$index].path $root $saved[$index].relative } catch { $restoreFailed = $true }
            }
            if ($restoreFailed) { throw ($failure + ' Restore incomplete. Keep KOReader closed and retry installation. Backups are preserved.') }
            throw ($failure + ' Previous components restored where overwritten. Keep KOReader closed and retry installation.')
        } finally {
            foreach ($item in @(Get-ChildItem -LiteralPath $scratch -File)) { Remove-Item -LiteralPath $item.FullName -Force }
            Remove-Item -LiteralPath $scratch -Force
        }
        exit 0
    }
    if ($payload.action -eq 'export-titles') {
        $destinationPath = [IO.Path]::GetFullPath($payload.destination)
        if (Test-Path -LiteralPath $destinationPath) { throw 'Title snapshot destination must be a new private directory.' }
        $rootFolder = Get-StorageFolder $device
        $component = Get-ChildFolder $rootFolder 'kindlespouse'
        if ($null -eq $component) { throw 'Collect notebook titles in KOReader first.' }
        $catalog = Get-ChildFolder $component.GetFolder 'catalog'
        if ($null -eq $catalog) { throw 'Collect notebook titles in KOReader first.' }
        New-Item -ItemType Directory -Path $destinationPath | Out-Null
        Add-Type -Path (Join-Path $PSScriptRoot 'NativeCopy.cs')
        $localFolder = $shell.Namespace($destinationPath)
        $verified = [Collections.Generic.List[object]]::new()
        foreach ($name in @('ksdk.content.db','cc.db')) {
            $item = @($catalog.GetFolder.Items() | Where-Object { -not $_.IsFolder -and (Get-ItemFilename $_) -eq $name }) | Select-Object -First 1
            if ($null -eq $item) { continue }
            $size = [long]$item.ExtendedProperty('System.Size')
            if ($size -lt 16 -or $size -gt 209715200) { throw 'Invalid title database size.' }
            [KindleNativeCopy]::CopyNamed($item,$localFolder.Self,$name)
            $filename = Join-Path $destinationPath $name
            if ((Get-Item -LiteralPath $filename).Length -ne $size) { throw 'Title database transfer incomplete.' }
            $verified.Add([pscustomobject]@{relative=$name;bytes=$size;sha256=(Get-FileSha256 $filename)})
        }
        if ($verified.Count -eq 0) { throw 'No title index found. Collect notebook titles in KOReader first.' }
        [IO.File]::WriteAllText((Join-Path $destinationPath 'snapshot-manifest.json'), (@{createdAt=[DateTime]::UtcNow.ToString('o');files=$verified} | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
        @{files=$verified.Count;directory=$destinationPath} | ConvertTo-Json -Compress
        exit 0
    }
    if ($payload.action -in @('export','export-notes')) {
        $destinationPath = [IO.Path]::GetFullPath($payload.destination)
        if (Test-Path -LiteralPath $destinationPath) { throw 'Snapshot destination must be a new private directory.' }
        New-Item -ItemType Directory -Path $destinationPath | Out-Null
        Add-Type -Path (Join-Path $PSScriptRoot 'NativeCopy.cs')
        $localFolder = $shell.Namespace($destinationPath)
        $rootFolder = Get-StorageFolder $device
        $files = [Collections.Generic.List[object]]::new()
        $directoryNames = if ($payload.action -eq 'export-notes') { @('.notebooks','documents','Books') } else { @('documents','Books') }
        foreach ($directoryName in $directoryNames) {
            $directoryItem = Get-ChildFolder $rootFolder $directoryName
            if ($null -ne $directoryItem) {
                Get-DeviceFiles $directoryItem.GetFolder $directoryName $files
                [KindleNativeCopy]::CopyNamed($directoryItem, $localFolder.Self, $directoryName)
            }
        }
        $verified = [Collections.Generic.List[object]]::new()
        foreach ($file in $files) {
            $localPath = [IO.Path]::GetFullPath((Join-Path $destinationPath $file.relative.Replace('/', '\')))
            if (-not $localPath.StartsWith($destinationPath.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid device path in snapshot.' }
            if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) { throw 'A file is missing from the snapshot.' }
            if ((Get-Item -LiteralPath $localPath).Length -ne $file.bytes) { throw 'A file changed during the snapshot; retry when the device is idle.' }
            $verified.Add([pscustomobject]@{ relative=$file.relative; bytes=$file.bytes; sha256=(Get-FileSha256 $localPath) })
        }
        $manifest = @{ createdAt=[DateTime]::UtcNow.ToString('o'); files=$verified }
        [IO.File]::WriteAllText((Join-Path $destinationPath 'snapshot-manifest.json'), ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        @{ files=$verified.Count; directory=$destinationPath } | ConvertTo-Json -Compress
        exit 0
    }
    $bookFormats = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'book-formats.json') -Raw | ConvertFrom-Json
    $supportedSuffix = @($bookFormats | Where-Object { $payload.filename.EndsWith('.' + $_, [StringComparison]::OrdinalIgnoreCase) })
    if ($payload.filename -notmatch '^[^<>:"/\\|?*\x00-\x1f]+$' -or -not $supportedSuffix.Count) { throw 'Invalid destination filename.' }
    $sourcePath = [IO.Path]::GetFullPath($payload.source)
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw 'Source file does not exist.' }
    if ((Get-FileSha256 $sourcePath) -ne $payload.sha256) { throw 'The confirmed file has changed.' }
    Add-Type -Path (Join-Path $PSScriptRoot 'NativeCopy.cs')
    $storageFolder = Get-StorageFolder $device
    $books = Ensure-ChildFolder $storageFolder 'Books'
    $inbox = Ensure-ChildFolder $books 'Inbox'
    $existing = @($inbox.Items() | Where-Object { (Get-ItemFilename $_) -eq $payload.filename }) | Select-Object -First 1
    if ($null -eq $existing) {
        $sourceFolder = $shell.Namespace([IO.Path]::GetDirectoryName($sourcePath))
        $sourceItem = $sourceFolder.ParseName([IO.Path]::GetFileName($sourcePath))
        [KindleNativeCopy]::CopyNamed($sourceItem, $inbox.Self, $payload.filename)
    }
    $deviceFile = $null
    for ($attempt=0; $attempt -lt 60; $attempt++) {
        $deviceFile = @($inbox.Items() | Where-Object { (Get-ItemFilename $_) -eq $payload.filename }) | Select-Object -First 1
        if ($null -ne $deviceFile) { break }
        Start-Sleep -Milliseconds 300
    }
    if ($null -eq $deviceFile) { throw 'The device did not expose the uploaded file.' }
    $verifyDirectory = Join-Path ([IO.Path]::GetTempPath()) ('KindleSpouse-Verify-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $verifyDirectory | Out-Null
    try {
        $verifyFolder = $shell.Namespace($verifyDirectory)
        [KindleNativeCopy]::CopyNamed($deviceFile, $verifyFolder.Self, $payload.filename)
        $verifyPath = Join-Path $verifyDirectory $payload.filename
        if (-not (Test-Path -LiteralPath $verifyPath -PathType Leaf)) { throw 'Cannot read the transferred file back for verification.' }
        if ((Get-FileSha256 $verifyPath) -ne $payload.sha256) { throw 'Transfer verification failed. Existing files have been preserved.' }
        @{ verified=$true; destination=('Books/Inbox/' + $payload.filename) } | ConvertTo-Json -Compress
    } finally {
        $verifyFile = Join-Path $verifyDirectory $payload.filename
        if (Test-Path -LiteralPath $verifyFile -PathType Leaf) { Remove-Item -LiteralPath $verifyFile -Force }
        Remove-Item -LiteralPath $verifyDirectory -Force
    }
} catch {
    @{ error=$_.Exception.Message } | ConvertTo-Json -Compress
    exit 0
}
