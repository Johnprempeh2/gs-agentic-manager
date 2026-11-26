# Screenshots of the Windows installer's wizard pages, window only, without installing:
# Welcome, the licence key page, the wrong-key message; then the wizard is closed.
# CI (release-assets.yml, Windows runner) only.
#   powershell -File scripts/release/inno-wizard-shots.ps1 <GSAM-Setup.exe> <out dir>
param([string]$Setup, [string]$Out)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][Win]::SetProcessDPIAware()
function Shot([string]$Name) {
  $r = New-Object Win+RECT
  [void][Win]::GetWindowRect([Win]::GetForegroundWindow(), [ref]$r)
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { $b = [Windows.Forms.Screen]::PrimaryScreen.Bounds; $r.Left = $b.Left; $r.Top = $b.Top; $w = $b.Width; $h = $b.Height }
  $bmp = New-Object Drawing.Bitmap $w, $h
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object Drawing.Size $w, $h))
  $bmp.Save((Join-Path $Out "$Name.png"), [Drawing.Imaging.ImageFormat]::Png)
  Write-Output "shot $Name ($w x $h)"
}
$shell = New-Object -ComObject WScript.Shell
$p = Start-Process -FilePath $Setup -PassThru
Start-Sleep -Seconds 10
[void]$shell.AppActivate("Setup - GSAM"); Start-Sleep -Seconds 1
Shot "windows-1-welcome"
$shell.SendKeys("{ENTER}"); Start-Sleep -Seconds 2
Shot "windows-2-licence-key"
$shell.SendKeys("not-a-key{ENTER}"); Start-Sleep -Seconds 2
Shot "windows-3-wrong-key"
$shell.SendKeys("{ENTER}"); Start-Sleep -Seconds 1
# Close without installing: end the wizard and its child process.
& taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
Get-Process | Where-Object { $_.Path -like "*\is-*\GSAM-Setup.tmp" } | Stop-Process -Force -ErrorAction SilentlyContinue
