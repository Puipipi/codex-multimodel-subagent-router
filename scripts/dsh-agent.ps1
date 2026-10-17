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
    $raw = $Arguments[$i]
    if (-not $raw.StartsWith('--') -or $raw.Length -lt 3) { throw "Expected --option, got: $raw" }
    $inline = $false
    $inlineValue = $null
    $equals = $raw.IndexOf('=')
    if ($equals -ge 0) {
        $key = $raw.Substring(0, $equals)
        $inlineValue = $raw.Substring($equals + 1)
        $inline = $true
    } else {
        $key = $raw
    }
    $name = $key.Substring(2).Replace('-', '_')
    if ($name -notmatch '^[A-Za-z][A-Za-z0-9_]*$') { throw "Invalid option name: $key" }
    if ($name -eq 'legacy') {
        if ($inline) { $values[$name] = $inlineValue; $i++ }
        elseif (($i + 1) -lt $Arguments.Count -and -not $Arguments[$i + 1].StartsWith('--')) { $values[$name] = $Arguments[$i + 1]; $i += 2 }
        else { $values[$name] = $true; $i++ }
    } elseif ($inline) {
        $values[$name] = $inlineValue
        $i++
    } elseif (($i + 1) -lt $Arguments.Count) {
        $values[$name] = $Arguments[$i + 1]
        $i += 2
    } else {
        throw "Missing value for $key"
    }
}

$required = @{
    start = @('task', 'cwd')
    wait = @('agent_id')
    result = @('agent_id')
    followup = @('agent_id', 'task')
    show = @('agent_id')
    list = @()
    interrupt = @('agent_id')
}
foreach ($name in $required[$Action]) {
    if (-not $values.Contains($name) -or $null -eq $values[$name] -or [string]::IsNullOrWhiteSpace([string]$values[$name])) {
        throw "$Action requires --$($name.Replace('_', '-'))"
    }
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
