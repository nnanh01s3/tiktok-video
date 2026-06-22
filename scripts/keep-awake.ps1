# keep-awake.ps1 — pin the system awake while a pipeline process runs.
#
# Why: powercfg standby-timeout=0 does NOT stop Windows Modern Standby (S0)
# from freezing Node mid-run (3 overnight freezes: 23:37 11/6, 00:59 12/6...).
# SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED) is the documented
# way apps (video players, downloads) block sleep entry.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File keep-awake.ps1 -ParentPid <pid>
#   - Re-asserts every 30s (belt and suspenders).
#   - Self-terminates within 30s of the parent process dying, so an orphaned
#     keeper can never pin the machine awake forever. Execution state clears
#     automatically when this process exits.
param([int]$ParentPid = 0)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PowerKeeper {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@

$ES_CONTINUOUS      = [uint32]"0x80000000"
$ES_SYSTEM_REQUIRED = [uint32]"0x00000001"
$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED

$prev = [PowerKeeper]::SetThreadExecutionState($flags)
if ($prev -eq 0) {
  Write-Output "keep-awake: SetThreadExecutionState FAILED"
  exit 1
}
Write-Output "keep-awake: active (parent=$ParentPid)"

while ($true) {
  if ($ParentPid -gt 0) {
    $p = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if (-not $p) { exit 0 }  # parent gone → release and exit
  }
  [PowerKeeper]::SetThreadExecutionState($flags) | Out-Null
  Start-Sleep -Seconds 30
}
