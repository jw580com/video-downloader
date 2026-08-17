# CPU/内存采样器：每 2 秒采样应用服务进程，输出 CSV
$ErrorActionPreference = 'SilentlyContinue'
$log = 'artifacts\stress\cpu-mem.csv'
New-Item -ItemType Directory -Force -Path 'artifacts\stress' | Out-Null
"ts,cpu_sec,mem_mb,handles" | Set-Content $log -Encoding utf8
while ($true) {
  if (Test-Path 'data\server.pid') {
    $pid = [int](Get-Content 'data\server.pid' -Raw)
    $p = Get-Process -Id $pid -ErrorAction SilentlyContinue
    if ($p) {
      $line = "{0},{1},{2},{3}" -f (Get-Date -Format 'HH:mm:ss'), ([math]::Round($p.CPU, 2)), ([math]::Round($p.WorkingSet64 / 1MB, 1)), $p.HandleCount
      Add-Content $log $line
    } else {
      Add-Content $log "server-process-missing"
    }
  } else {
    Add-Content $log "no-pidfile"
  }
  Start-Sleep -Seconds 2
}
