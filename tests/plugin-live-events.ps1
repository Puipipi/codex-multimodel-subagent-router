$ErrorActionPreference = 'Stop'

# Read-only live contract check against the installed published DSH 0.7
# runtime. It uses the existing completed agent below and never calls
# dsh_start, dsh_attach, dsh_watch, or the plugin ownership store.
$agentId = 'ffbbbc39-f3c0-4d78-86cf-b1df492eed14'
$checks = 0
function Ok([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
    $script:checks += 1
}

$candidates = @()
$cacheRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
if (Test-Path -LiteralPath $cacheRoot) {
    $candidates += Get-ChildItem -LiteralPath $cacheRoot -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'node_modules\dsh-subagent-mcp\src\cli.mjs' }
}
$globalRoot = npm root -g 2>$null
if ($globalRoot) { $candidates += Join-Path $globalRoot 'dsh-subagent-mcp\src\cli.mjs' }
$cli = $candidates | Where-Object {
    if (-not $_ -or -not (Test-Path -LiteralPath $_ -PathType Leaf)) { return $false }
    $package = Join-Path (Split-Path (Split-Path $_ -Parent) -Parent) 'package.json'
    if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { return $false }
    $version = (Get-Content -LiteralPath $package -Raw | ConvertFrom-Json).version
    return $version -eq '0.7.0'
} | Select-Object -First 1

if (-not $cli) {
    Write-Output 'SKIP live DSH events: published dsh-subagent-mcp@0.7.0 is not installed in the npm cache or global root.'
    exit 0
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("sol-luna-live-events-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$inputPath = Join-Path $temp 'in.jsonl'
$outputPath = Join-Path $temp 'out.jsonl'
$errorPath = Join-Path $temp 'err.txt'

try {
    $frames = @(
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sol-luna-live-events","version":"1.0.0"}}}',
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        ('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"dsh_status","arguments":{"agent_id":"' + $agentId + '"}}}'),
        ('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dsh_events","arguments":{"agent_id":"' + $agentId + '","limit":5,"max_chars":20000,"include_progress":true,"include_tool_events":true}}}')
    )
    [System.IO.File]::WriteAllText($inputPath, (($frames -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))

    $node = (Get-Command node -ErrorAction Stop).Source
    $process = Start-Process -FilePath $node -ArgumentList @("`"$cli`"", 'mcp') `
        -RedirectStandardInput $inputPath -RedirectStandardOutput $outputPath -RedirectStandardError $errorPath `
        -WindowStyle Hidden -Wait -PassThru

    if (Test-Path -LiteralPath $errorPath) {
        $stderr = Get-Content -LiteralPath $errorPath -Raw
        if ($stderr) { Write-Output "live stderr: $($stderr.Trim())" }
    }
    if (-not (Test-Path -LiteralPath $outputPath)) { throw 'FAIL: DSH produced no MCP output.' }
    $messages = Get-Content -LiteralPath $outputPath | Where-Object { $_.Trim() } | ForEach-Object {
        try { $_ | ConvertFrom-Json } catch { }
    }

    $init = $messages | Where-Object { $_.id -eq 1 } | Select-Object -First 1
    Ok ($null -ne $init) 'initialize response is present'
    Ok ($init.result.serverInfo.name -eq 'dsh-subagent-mcp') 'the published DSH server identifies itself'
    Ok ($init.result.serverInfo.version -eq '0.7.0') 'the live server is dsh-subagent-mcp 0.7.0'

    $show = $messages | Where-Object { $_.id -eq 2 } | Select-Object -First 1
    Ok ($null -ne $show) 'dsh_status response is present'
    $showPayload = $show.result.content[0].text | ConvertFrom-Json
    Write-Output "legacy agent status: $($showPayload.status)"
    Ok ($showPayload.status -in @('completed', 'idle', 'closed', 'interrupted', 'error', 'context_exhausted')) 'the legacy agent is terminal or idle before the read'

    $eventsMessage = $messages | Where-Object { $_.id -eq 3 } | Select-Object -First 1
    Ok ($null -ne $eventsMessage) 'dsh_events response is present'
    $payload = $eventsMessage.result.content[0].text | ConvertFrom-Json
    $names = @($payload.PSObject.Properties.Name)
    Ok ($names -contains 'events') 'the real payload exposes events'
    Ok (-not ($names -contains 'items')) 'the real payload does not use items'
    Ok ($names -contains 'has_more') 'the real payload exposes has_more'
    Ok ($names -contains 'next_cursor') 'the real payload exposes next_cursor'
    Ok ($payload.events -is [System.Array]) 'events is an array'
    Ok (@($payload.events).Count -gt 0) 'events contains real recorded activity'
    Ok ($payload.has_more -is [bool]) 'has_more is a boolean'
    if ($payload.has_more) {
        Ok ($null -ne $payload.next_cursor) 'has_more carries a continuation cursor'
    }
    $first = @($payload.events)[0]
    Ok ($null -ne $first.event_id) 'each event carries event_id'
    Ok (-not [string]::IsNullOrWhiteSpace([string]$first.type)) 'each event carries a type'

    Write-Output "legacy events: count=$(@($payload.events).Count) has_more=$($payload.has_more) next_cursor=$($payload.next_cursor) fields=$($names -join ',')"
    Write-Output "PASS $checks live read-only DSH events assertions (agent $agentId)"
}
finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
