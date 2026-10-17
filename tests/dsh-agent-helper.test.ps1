$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $skillRoot 'scripts\dsh-agent.ps1'
$tempRoot = [IO.Path]::GetFullPath($env:TEMP)
$temp = Join-Path $tempRoot ("dsh-mcp-helper-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
$npmBin = Join-Path $temp 'node_modules\npm\bin'
New-Item -ItemType Directory -Path $npmBin -Force | Out-Null
@'
@echo off
echo %ROUTER_TEST_NPM_ROOT%
'@ | Set-Content -LiteralPath (Join-Path $temp 'npm.cmd') -Encoding ascii
$fakeNpx = Join-Path $npmBin 'npx-cli.js'
@'
process.stdin.setEncoding('utf8');
let data='';
process.stdin.on('data', x => {
  data += x;
  for (;;) {
    const n=data.indexOf('\n'); if(n<0) break;
    const line=data.slice(0,n).trim(); data=data.slice(n+1); if(!line) continue;
    const q=JSON.parse(line);
    if (q.id === undefined) continue;
    if (q.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{serverInfo:{name:'fake-dsh'}}})+'\n');
    else if (q.method === 'tools/call') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:JSON.stringify({name:q.params.name,args:q.params.arguments})}]}})+'\n');
  }
});
'@ | Set-Content -LiteralPath $fakeNpx -Encoding utf8
$oldPath = $env:Path
$oldNpmRoot = $env:ROUTER_TEST_NPM_ROOT
try {
    $env:Path = "$temp;$oldPath"
    $env:ROUTER_TEST_NPM_ROOT = $temp
    $task = '修复 parser: keep spaces, "quotes" & symbols intact'
    $cwd = 'C:\work folder\项目'
    $raw = & $helper start --task $task --cwd $cwd --permission workspace-write
    if ($LASTEXITCODE -ne 0) { throw "helper exited $LASTEXITCODE" }
    $response = ConvertFrom-Json ($raw -join '')
    $toolCall = ConvertFrom-Json $response.result.content[0].text
    if ($toolCall.name -ne 'dsh_start' -or $toolCall.args.task -ne $task -or $toolCall.args.cwd -ne $cwd -or $toolCall.args.provider -ne 'deepseek-official' -or $toolCall.args.model -ne 'deepseek-flash') {
        throw 'MCP start mapping or argument forwarding failed.'
    }
    $raw = & $helper wait AGENT_123
    if ($LASTEXITCODE -ne 0) { throw "wait helper exited $LASTEXITCODE" }
    $response = ConvertFrom-Json ($raw -join '')
    $toolCall = ConvertFrom-Json $response.result.content[0].text
    if ($toolCall.name -ne 'dsh_wait' -or $toolCall.args.agent_id -ne 'AGENT_123') { throw 'wait must call upstream dsh_wait with the same agent ID.' }
    'PASS PowerShell helper preserves Unicode, spaces, quotes, symbols, and maps start/wait to published MCP tools.'
} finally {
    $env:Path = $oldPath
    $env:ROUTER_TEST_NPM_ROOT = $oldNpmRoot
    $resolvedTemp = [IO.Path]::GetFullPath($temp)
    if (-not $resolvedTemp.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to remove temporary data outside TEMP.' }
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
}
