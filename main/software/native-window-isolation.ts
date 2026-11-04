import { execFile } from 'node:child_process'

/** Keep formal Electron tests outside the user's desktop input area. This is
 * still a real, non-minimized native window; it does not replace the renderer,
 * audio engine or app event handlers. Only the owned process tree is eligible;
 * Windows launchers can have a different PID from Electron's main process. */
export async function isolateNativeTestWindows(pid: number, signal?: AbortSignal): Promise<{ method: string; windows: unknown[]; owner_pid?:number; owned_pids?:number[] }> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('GUI_TEST_WINDOW_OWNER_INVALID')
  signal?.throwIfAborted()
  if (process.platform !== 'win32') return { method: 'not_required_on_this_platform', windows: [] }
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BlomaTestWindows {
  public delegate bool EnumCallback(IntPtr window, IntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  public class Evidence { public long Handle; public int ProcessId, Left, Top, Width, Height; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback cb, IntPtr extra);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  public static Evidence[] Move(uint[] owners) {
    var rows = new List<Evidence>();
    var owned = new HashSet<uint>(owners);
    int right = GetSystemMetrics(76) + GetSystemMetrics(78);
    EnumWindows((window, extra) => {
      uint pid; GetWindowThreadProcessId(window, out pid);
      if (!owned.Contains(pid) || !IsWindowVisible(window)) return true;
      Rect before, after;
      if (!GetWindowRect(window, out before)) throw new Exception("WINDOW_RECT_FAILED");
      if (before.Right <= before.Left || before.Bottom <= before.Top) return true;
      // NOSIZE | NOZORDER | NOACTIVATE: preserve rendering and avoid stealing focus.
      if (!SetWindowPos(window, IntPtr.Zero, right + 512, before.Top, 0, 0, 0x0015) || !GetWindowRect(window, out after)) throw new Exception("WINDOW_MOVE_FAILED");
      if (after.Left < right || after.Right-after.Left != before.Right-before.Left || after.Bottom-after.Top != before.Bottom-before.Top) throw new Exception("WINDOW_ISOLATION_NOT_ESTABLISHED");
      rows.Add(new Evidence { Handle=window.ToInt64(), ProcessId=(int)pid, Left=after.Left, Top=after.Top, Width=after.Right-after.Left, Height=after.Bottom-after.Top });
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }
}
'@
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
if ($processes.ProcessId -notcontains ${pid}) { throw 'OWNED_TEST_PROCESS_MISSING' }
$owned = New-Object 'System.Collections.Generic.HashSet[uint32]'
$null = $owned.Add(${pid})
do {
  $added = $false
  foreach ($entry in $processes) {
    if ($owned.Contains([uint32]$entry.ParentProcessId) -and $owned.Add([uint32]$entry.ProcessId)) { $added = $true }
  }
} while ($added)
$rows = @()
for ($attempt = 0; $attempt -lt 100; $attempt++) {
  $rows = @([BlomaTestWindows]::Move([uint32[]]@($owned)))
  if ($rows.Count -gt 0) { break }
  Start-Sleep -Milliseconds 50
}
if ($rows.Count -eq 0) { throw 'OWNED_TEST_WINDOW_NOT_VISIBLE' }
ConvertTo-Json -InputObject @{owner_pid=${pid};owned_pids=@($owned);windows=$rows} -Depth 4 -Compress
`
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000, signal, maxBuffer: 65536 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`GUI_TEST_WINDOW_ISOLATION_FAILED: ${String(stderr || error.message).slice(0, 1200)}`))
        else resolve(stdout)
      })
  })
  const receipt = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()),windows=receipt.windows
  if (receipt.owner_pid!==pid || !Array.isArray(receipt.owned_pids) || !receipt.owned_pids.includes(pid) || !Array.isArray(windows) || !windows.length || windows.some(w => !receipt.owned_pids.includes(w.ProcessId) || !(w.Width > 0 && w.Height > 0))) throw Error('GUI_TEST_WINDOW_ISOLATION_RECEIPT_INVALID')
  return { method: 'owned_visible_windows_outside_virtual_desktop', owner_pid:pid,owned_pids:receipt.owned_pids,windows }
}
