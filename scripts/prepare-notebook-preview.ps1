$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$staging = Join-Path $projectRoot ('.test-data/notebook-preview-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $staging 'originals') -Force | Out-Null
Add-Type -Path (Join-Path $projectRoot 'native/NativeCopy.cs')
function FindItem($Folder, [string]$Name) {
    return @($Folder.Items() | Where-Object { $actual = $_.ExtendedProperty('System.FileName'); if (!$actual) { $actual = $_.Name }; $actual -ceq $Name }) | Select-Object -First 1
}
$shellApp = New-Object -ComObject Shell.Application
$devices = @($shellApp.Namespace(17).Items() | Where-Object { $_.Name -like 'Kindle*' })
if ($devices.Count -ne 1) { throw 'Exit KOReader and connect exactly one Kindle.' }
$root = @($devices[0].GetFolder.Items())[0].GetFolder
$notebooks = FindItem $root '.notebooks'
$inputs = @()
$skipped = 0
if ($notebooks -and $notebooks.IsFolder) {
    foreach ($item in @($notebooks.GetFolder.Items())) {
        $name = $item.ExtendedProperty('System.FileName')
        if (!$name) { $name = $item.Name }
        if (!$item.IsFolder -or $name -notmatch '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$') { continue }
        $folder = $item.GetFolder
        $nbk = FindItem $folder 'nbk'
        if (!$nbk -or $nbk.IsFolder) { continue }
        $active = $false
        foreach ($journal in @('nbk-journal','nbk-wal')) {
            $file = FindItem $folder $journal
            if ($file -and [long]$file.ExtendedProperty('System.Size') -gt 0) { $active = $true }
        }
        $bytes = [long]$nbk.ExtendedProperty('System.Size')
        if ($active -or $bytes -lt 16 -or $bytes -gt 100MB) { $skipped++; continue }
        $destination = Join-Path $staging ('originals/' + $name)
        New-Item -ItemType Directory -Path $destination | Out-Null
        $local = $shellApp.Namespace($destination)
        [KindleNativeCopy]::CopyNamed($nbk, $local.Self, 'nbk')
        $filename = Join-Path $destination 'nbk'
        if ((Get-Item -LiteralPath $filename).Length -ne $bytes) { throw 'Notebook snapshot incomplete; no device files changed.' }
        $inputs += @{identity=$name;source=$filename;sha256=(Get-FileHash -LiteralPath $filename -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
}
[IO.File]::WriteAllText((Join-Path $staging 'inputs.json'), (@{notebooks=@($inputs);skipped=$skipped} | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $projectRoot '.test-data/notebook-preview-latest.txt'), $staging, [Text.UTF8Encoding]::new($false))
@{staging=$staging;notebookCopies=$inputs.Count;skippedActiveOrUnsupported=$skipped;deviceChanged=$false} | ConvertTo-Json -Compress
