#requires -Version 7.3
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('start', 'wait', 'result', 'followup', 'show', 'list', 'interrupt')]
    [string] $Action,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
)

$ErrorActionPreference = 'Stop'
$values = [ordered]@{}
$i = 0
if ($Action -in @('wait', 'result', 'followup', 'show', 'interrupt') -and $Arguments.Count -gt 0 -and -not $Arguments[0].StartsWith('--')) {
    $values.agent_id = $Arguments[0]
    $i = 1
}
while ($i -lt $Arguments.Count) {
    $key = $Arguments[$i]
    if (-not $key.StartsWith('--') -or $key.Length -lt 3) { throw "Expected --option, got: $key" }
    $name = $key.Substring(2).Replace('-', '_')
    if (($i + 1) -ge $Arguments.Count -or $Arguments[$i + 1].StartsWith('--')) { $values[$name] = $true; $i++ }
    else { $values[$name] = $Arguments[$i + 1]; $i += 2 }
}

$npm = Get-Command npm.cmd -ErrorAction Stop
$globalModules = (& $npm.Source root -g).Trim()
if ($LASTEXITCODE -ne 0 -or -not $globalModules) { throw 'Cannot locate npm global modules.' }
$npmDir = Split-Path -Parent $npm.Source
$npxCli = @((Join-Path $npmDir 'node_modules\npm\bin\npx-cli.js'), (Join-Path $globalModules 'npm\bin\npx-cli.js')) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $npxCli) { throw 'Cannot locate npm npx-cli.js.' }
$node = (Get-Command node -ErrorAction Stop).Source
$client = Join-Path $PSScriptRoot 'dsh-mcp-client.mjs'
$payload = @{action = $Action; args = $values; npxCli = $npxCli} | ConvertTo-Json -Depth 10 -Compress
$psi = [Diagnostics.ProcessStartInfo]::new($node)
$psi.ArgumentList.Add($client)
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
$psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
$psi.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
$process = [Diagnostics.Process]::new()
$process.StartInfo = $psi
if (-not $process.Start()) { throw 'Failed to start the DSH MCP client.' }
$process.StandardInput.Write($payload)
$process.StandardInput.Close()
$stdout = $process.StandardOutput.ReadToEnd()
$stderr = $process.StandardError.ReadToEnd()
$process.WaitForExit()
if ($stdout) { Write-Output -NoEnumerate $stdout }
if ($stderr) { [Console]::Error.Write($stderr) }
exit $process.ExitCode
