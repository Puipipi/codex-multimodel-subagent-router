$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path -Parent $PSScriptRoot
$repoHelper = Join-Path $skillRoot 'scripts\dsh-agent.ps1'
$tempRoot = [IO.Path]::GetFullPath($env:TEMP)
$temp = Join-Path $tempRoot ("dsh-mcp-helper-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null

function Assert-Equal([object] $Actual, [object] $Expected, [string] $Message) {
    $sameType = ($null -eq $Actual -and $null -eq $Expected) -or
        ($null -ne $Actual -and $null -ne $Expected -and $Actual.GetType().FullName -eq $Expected.GetType().FullName)
    if (-not $sameType -or "$Actual" -cne "$Expected") {
        throw "$Message`nExpected: <$Expected> ($(if ($null -ne $Expected) { $Expected.GetType().Name } else { 'null' }))`nActual:   <$Actual> ($(if ($null -ne $Actual) { $Actual.GetType().Name } else { 'null' }))"
    }
}

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

function New-FakeNpm([string] $Root, [switch] $WithoutNpx) {
    $npmBin = Join-Path $Root 'node_modules\npm\bin'
    New-Item -ItemType Directory -Path $npmBin -Force | Out-Null
    @'
@echo off
echo %ROUTER_TEST_NPM_ROOT%
'@ | Set-Content -LiteralPath (Join-Path $Root 'npm.cmd') -Encoding ascii
    if (-not $WithoutNpx) {
        @'
process.stdin.resume();
'@ | Set-Content -LiteralPath (Join-Path $npmBin 'npx-cli.js') -Encoding utf8
    }
}

function New-CaptureHarness([string] $Root) {
    $scripts = Join-Path $Root 'scripts'
    New-Item -ItemType Directory -Path $scripts -Force | Out-Null
    Copy-Item -LiteralPath $repoHelper -Destination (Join-Path $scripts 'dsh-agent.ps1')
    @'
import {readFileSync, writeFileSync} from 'node:fs';
const payload = readFileSync(0, 'utf8');
writeFileSync(process.env.ROUTER_TEST_PAYLOAD, payload, 'utf8');
process.stdout.write(JSON.stringify({server: 'fake-dsh', tool: 'captured', result: {ok: true}}) + '\n');
'@ | Set-Content -LiteralPath (Join-Path $scripts 'dsh-mcp-client.mjs') -Encoding utf8
    New-FakeNpm $Root
    return Join-Path $scripts 'dsh-agent.ps1'
}

function Invoke-Captured([string] $Helper, [string[]] $CliArguments, [string] $PayloadPath) {
    Remove-Item -LiteralPath $PayloadPath -Force -ErrorAction SilentlyContinue
    $errorText = ''
    try {
        & $Helper @CliArguments
        $code = $LASTEXITCODE
    } catch {
        $code = 1
        $errorText = $_.Exception.Message
    }
    $payload = $null
    if (Test-Path -LiteralPath $PayloadPath) {
        $payload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding utf8 | ConvertFrom-Json
    }
    [pscustomobject]@{ExitCode = $code; Error = $errorText; Payload = $payload}
}

$oldPath = $env:Path
$oldNpmRoot = $env:ROUTER_TEST_NPM_ROOT
$oldPayload = $env:ROUTER_TEST_PAYLOAD
$oldTransport = $env:SOL_LUNA_DSH_TRANSPORT
$languageInstruction = '用户可见的进度与最终报告必须使用简体中文；代码、命令和内部 GPT-DeepSeek 通信可保持原文。'
$captureRoot = Join-Path $temp 'capture'
$captureHelper = New-CaptureHarness $captureRoot
$payloadPath = Join-Path $temp 'payload.json'
$null = New-Item -ItemType Directory -Path (Join-Path $temp 'empty-path') -Force

try {
    $env:Path = "$captureRoot;$oldPath"
    $env:ROUTER_TEST_NPM_ROOT = $captureRoot
    $env:ROUTER_TEST_PAYLOAD = $payloadPath

    $task = @'
修复 parser: keep spaces, "double quotes", 'single quotes', & < > | $HOME `backtick`
second line: 中文 🚀, tabs	and symbols # % ^ + = ~
'@
    $cwd = 'C:\work folder\项目'
    $result = Invoke-Captured $captureHelper @(
        'start', '--task', $task, '--cwd', $cwd, '--name', 'build/测试',
        '--model', 'deepseek-chat', '--provider', 'deepseek-official',
        '--effort', 'high', '--preset', 'standard', '--permission', 'workspace-write'
    ) $payloadPath
    Assert-Equal $result.ExitCode 0 'start through the capture helper must succeed'
    Assert-Equal $result.Payload.action 'start' 'start action must be preserved'
    Assert-Equal $result.Payload.args.task $task 'multiline Unicode task must survive PowerShell parsing'
    Assert-Equal $result.Payload.args.cwd $cwd 'cwd must survive PowerShell parsing'
    Assert-Equal $result.Payload.args.name 'build/测试' 'name must be preserved'
    Assert-Equal $result.Payload.args.model 'deepseek-chat' 'model must be preserved'
    Assert-Equal $result.Payload.args.provider 'deepseek-official' 'provider must be preserved'
    Assert-Equal $result.Payload.args.effort 'high' 'effort must be preserved'
    Assert-Equal $result.Payload.args.preset 'standard' 'preset must be preserved'
    Assert-Equal $result.Payload.args.permission 'workspace-write' 'permission must be preserved'

    $optionTask = '--verbose --keep "quotes" & symbols | < >'
    $result = Invoke-Captured $captureHelper @('start', '--task', $optionTask, '--cwd', $cwd) $payloadPath
    Assert-Equal $result.ExitCode 0 'option-like task value must be accepted'
    Assert-Equal $result.Payload.args.task $optionTask 'option-like task value must not become a boolean flag'

    $equalsTask = '--literal --flag=value'
    $result = Invoke-Captured $captureHelper @('start', "--task=$equalsTask", '--cwd', $cwd) $payloadPath
    Assert-Equal $result.ExitCode 0 '--task=value syntax must be accepted'
    Assert-Equal $result.Payload.args.task $equalsTask '--task=value must preserve an option-like value'

    $result = Invoke-Captured $captureHelper @('wait', 'AGENT_123', '--legacy') $payloadPath
    Assert-Equal $result.ExitCode 0 'wait with a positional agent ID must succeed'
    Assert-Equal $result.Payload.action 'wait' 'wait action must be preserved'
    Assert-Equal $result.Payload.args.agent_id 'AGENT_123' 'wait agent ID must be preserved'
    Assert-Equal $result.Payload.args.legacy $true 'bare --legacy must become a boolean'

    $followupTask = 'Fix: $var & < > | line 1' + "`n" + 'line 2 — 中文'
    $result = Invoke-Captured $captureHelper @('followup', 'AGENT_456', '--task', $followupTask, '--legacy', 'false') $payloadPath
    Assert-Equal $result.ExitCode 0 'followup must succeed'
    Assert-Equal $result.Payload.args.agent_id 'AGENT_456' 'followup agent ID must be preserved'
    Assert-Equal $result.Payload.args.task $followupTask 'followup task must be preserved'
    Assert-Equal $result.Payload.args.legacy 'false' 'explicit legacy=false must be forwarded for the client to normalize'

    $result = Invoke-Captured $captureHelper @('list', '--limit', '20', '--max-chars', '12000', '--status', 'idle') $payloadPath
    Assert-Equal $result.ExitCode 0 'list must succeed'
    Assert-Equal $result.Payload.args.limit '20' 'numeric CLI values reach the client as strings'
    Assert-Equal $result.Payload.args.max_chars '12000' 'hyphenated options map to snake_case'
    Assert-Equal $result.Payload.args.status 'idle' 'list filter must be preserved'

    $clientPath = Join-Path $skillRoot 'scripts\dsh-mcp-client.mjs'
    $clientError = '{"action":"start","args":{"task":"work"}}' | & node $clientPath 2>&1
    Assert-Equal $LASTEXITCODE 1 'the MCP client CLI must exit 1 on an invalid request'
    Assert-True (($clientError -join "`n").Contains('start requires task and cwd')) 'the MCP client CLI error must name the missing argument'

    $fakeSecret = 'sk-' + ('A' * 24)
    $secretRequest = @{action = $fakeSecret; args = @{}} | ConvertTo-Json -Compress
    $secretError = $secretRequest | & node $clientPath 2>&1
    Assert-Equal $LASTEXITCODE 1 'the MCP client CLI must fail an unsupported action'
    Assert-True (-not (($secretError -join "`n").Contains($fakeSecret))) 'the MCP client CLI must not print a credential-shaped value'
    Assert-True (($secretError -join "`n").Contains('<REDACTED_KEY>')) 'the MCP client CLI must redact credential-shaped values'

    foreach ($case in @(
        @{Name = 'start without cwd'; Args = @('start', '--task', 'work'); Pattern = 'cwd'},
        @{Name = 'start without task'; Args = @('start', '--cwd', $cwd); Pattern = 'task'},
        @{Name = 'start with missing task value'; Args = @('start', '--task'); Pattern = 'task'},
        @{Name = 'start with missing cwd value'; Args = @('start', '--task', 'work', '--cwd'); Pattern = 'cwd'},
        @{Name = 'wait without agent'; Args = @('wait'); Pattern = 'agent'},
        @{Name = 'followup without task'; Args = @('followup', 'AGENT_1'); Pattern = 'task'}
    )) {
        $result = Invoke-Captured $captureHelper $case.Args $payloadPath
        Assert-True ($result.ExitCode -ne 0) "$($case.Name) must fail"
        Assert-True ($result.Error.ToLowerInvariant().Contains($case.Pattern)) "$($case.Name) must name the missing argument"
        Assert-True ($null -eq $result.Payload) "$($case.Name) must fail before spawning the MCP client"
    }

    $env:Path = Join-Path $temp 'empty-path'
    $result = Invoke-Captured $captureHelper @('start', '--task', 'work', '--cwd', $cwd) $payloadPath
    Assert-True ($result.ExitCode -ne 0) 'missing npm.cmd must fail'
    Assert-True ($result.Error.Contains('npm.cmd')) 'missing npm.cmd error must name npm.cmd'

    $missingNpxRoot = Join-Path $temp 'missing-npx'
    New-FakeNpm $missingNpxRoot -WithoutNpx
    $env:Path = "$missingNpxRoot;$oldPath"
    $env:ROUTER_TEST_NPM_ROOT = $missingNpxRoot
    $result = Invoke-Captured $captureHelper @('start', '--task', 'work', '--cwd', $cwd) $payloadPath
    Assert-True ($result.ExitCode -ne 0) 'missing npx-cli.js must fail'
    Assert-True ($result.Error.Contains('npx-cli.js')) 'missing npx-cli.js error must name the prerequisite'

    $missingNodeRoot = Join-Path $temp 'missing-node'
    New-FakeNpm $missingNodeRoot
    $env:Path = $missingNodeRoot
    $env:ROUTER_TEST_NPM_ROOT = $missingNodeRoot
    $result = Invoke-Captured $captureHelper @('start', '--task', 'work', '--cwd', $cwd) $payloadPath
    Assert-True ($result.ExitCode -ne 0) 'missing node must fail'
    Assert-True ($result.Error.Contains('node')) 'missing node error must name node'

    $env:Path = "$captureRoot;$oldPath"
    $env:ROUTER_TEST_NPM_ROOT = $captureRoot
    $env:ROUTER_TEST_PAYLOAD = $payloadPath

    $probe = Join-Path $temp 'spawn-probe.cjs'
    @'
const {spawnSync} = require('node:child_process');
const result = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], {encoding: 'utf8', windowsHide: true});
if (result.error?.code === 'EPERM') process.exit(3);
process.stdout.write(result.stdout || '');
'@ | Set-Content -LiteralPath $probe -Encoding utf8
    $probeOutput = & node $probe
    $nestedSpawn = $LASTEXITCODE -eq 0 -and ($probeOutput -join '') -eq 'ok'
    Assert-True $nestedSpawn 'real helper/client integration requires a hidden nested child spawn; host permissions must allow it'
    $integrationRoot = Join-Path $temp 'integration'
    New-FakeNpm $integrationRoot
    $fakeNpx = Join-Path $integrationRoot 'node_modules\npm\bin\npx-cli.js'
    @'
process.stdin.setEncoding('utf8');
let data = '';
process.stdin.on('data', chunk => {
  data += chunk;
  for (;;) {
    const end = data.indexOf('\n');
    if (end < 0) break;
    const line = data.slice(0, end).trim();
    data = data.slice(end + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: request.id, result: {serverInfo: {name: 'fake-dsh'}}}) + '\n');
    } else if (request.method === 'tools/call') {
      process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: request.id, result: {content: [{type: 'text', text: JSON.stringify({name: request.params.name, args: request.params.arguments})}]}}) + '\n');
    }
  }
});
'@ | Set-Content -LiteralPath $fakeNpx -Encoding utf8
    $env:Path = "$integrationRoot;$oldPath"
    $env:ROUTER_TEST_NPM_ROOT = $integrationRoot
    $env:SOL_LUNA_DSH_TRANSPORT = 'npx'
    $raw = & $repoHelper start --task $optionTask --cwd $cwd --permission workspace-write
    Assert-Equal $LASTEXITCODE 0 'real helper/client integration must exit successfully'
    $response = ConvertFrom-Json ($raw -join '')
    $toolCall = ConvertFrom-Json $response.result.content[0].text
    Assert-Equal $toolCall.name 'dsh_start' 'integration must call dsh_start'
    Assert-True ($toolCall.args.task.StartsWith($optionTask)) 'integration must preserve an option-like task verbatim'
    Assert-True ($toolCall.args.task.EndsWith($languageInstruction)) 'integration must append the Chinese language instruction'
    Assert-Equal (($toolCall.args.task -split [regex]::Escape($languageInstruction)).Count - 1) 1 'integration must send the language marker once'
    Assert-Equal $toolCall.args.cwd $cwd 'integration must preserve cwd'
    Assert-Equal $toolCall.args.provider 'deepseek-official' 'integration must default the provider'
    Assert-Equal $toolCall.args.model 'deepseek-flash' 'integration must default the model'

    $followRaw = & $repoHelper followup AGENT_789 --task $optionTask
    Assert-Equal $LASTEXITCODE 0 'real helper/client followup integration must exit successfully'
    $followCall = ConvertFrom-Json ((ConvertFrom-Json ($followRaw -join '')).result.content[0].text)
    Assert-True ($followCall.args.task.StartsWith($optionTask)) 'integration followup must preserve its task verbatim'
    Assert-True ($followCall.args.task.EndsWith($languageInstruction)) 'integration followup must append the Chinese language instruction'
    Assert-Equal (($followCall.args.task -split [regex]::Escape($languageInstruction)).Count - 1) 1 'integration followup must send the language marker once'

    Write-Output 'PASS PowerShell helper argument, validation, prerequisite, and hidden real helper/client integration coverage.'
} finally {
    $env:Path = $oldPath
    $env:ROUTER_TEST_NPM_ROOT = $oldNpmRoot
    $env:ROUTER_TEST_PAYLOAD = $oldPayload
    $env:SOL_LUNA_DSH_TRANSPORT = $oldTransport
    $resolvedTemp = [IO.Path]::GetFullPath($temp)
    if (-not $resolvedTemp.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to remove temporary data outside TEMP.' }
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
}
