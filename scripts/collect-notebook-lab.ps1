$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Add-Type -Path (Join-Path $projectRoot 'native/NativeCopy.cs')
function FindItem($Folder, [string]$Name) {
    return @($Folder.Items() | Where-Object { $actual = $_.ExtendedProperty('System.FileName'); if (!$actual) { $actual = $_.Name }; $actual -ceq $Name }) | Select-Object -First 1
}
$shellApp = New-Object -ComObject Shell.Application
$devices = @($shellApp.Namespace(17).Items() | Where-Object { $_.Name -like 'Kindle*' })
if ($devices.Count -ne 1) { throw 'Connect exactly one Kindle.' }
$folder = @($devices[0].GetFolder.Items())[0].GetFolder
foreach ($part in @('kindlespouse','notebook-lab')) {
    $item = FindItem $folder $part
    if (!$item -or !$item.IsFolder) { throw 'No Notebook Lab recording found.' }
    $folder = $item.GetFolder
}
$runs = @($folder.Items() | Where-Object { $_.IsFolder -and $_.Name -match '^\d{8}T\d{6}Z-\d+$' } | Sort-Object Name -Descending | Select-Object -First 1)
if (!$runs.Count) { throw 'No Notebook Lab recording found.' }
$destination = Join-Path $projectRoot ('.test-data/notebook-lab-readback-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $destination | Out-Null
$local = $shellApp.Namespace($destination)
$run = $runs[0].GetFolder
$files = @()
$total = 0
foreach ($name in @('status.txt','capabilities.txt','navigation.txt','launch-result.txt','appreg-schema.txt','appreg.db','appreg-backup-error.txt')) {
    $item = FindItem $run $name
    if (!$item -or $item.IsFolder) { continue }
    $bytes = [long]$item.ExtendedProperty('System.Size')
    $total += $bytes
    if ($bytes -gt 8MB -or $total -gt 12MB) { throw 'Unexpected diagnostic file size.' }
    [KindleNativeCopy]::CopyNamed($item, $local.Self, $name)
    $filename = Join-Path $destination $name
    if ((Get-Item -LiteralPath $filename).Length -ne $bytes) { throw 'Diagnostic file changed during readback. Wait for recording to finish.' }
    $files += @{name=$name;bytes=$bytes;sha256=(Get-FileHash -LiteralPath $filename -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$status = Get-Content -LiteralPath (Join-Path $destination 'status.txt') -Raw
[IO.File]::WriteAllText((Join-Path $destination 'manifest.json'), (@{files=$files;recording=$runs[0].Name;status=$status.Trim()} | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
@{directory=$destination;files=$files.Count;status=$status.Trim();deviceChanged=$false} | ConvertTo-Json -Compress
