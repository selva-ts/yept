# Finds the window whose title contains -Title, then resizes it (-Resize), clicks at a point in it (-Click "x,y",
# measured from the window's visible top-left corner), or saves it as a PNG (-Out), without the invisible resize border.
param([string]$Title, [string]$Out, [int]$Width = 1600, [int]$Height = 1000, [switch]$Resize, [string]$Click)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class YeptWindow {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, IntPtr e);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var s = new StringBuilder(512);
      GetWindowText(h, s, 512);
      if (IsWindowVisible(h) && s.ToString().Contains(title)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[YeptWindow]::SetProcessDPIAware() | Out-Null
$h = [YeptWindow]::Find($Title)
if ($h -eq [IntPtr]::Zero) { Write-Error "No window titled '$Title'"; exit 2 }
# The visible frame (DWMWA_EXTENDED_FRAME_BOUNDS), without the invisible resize border.
$frame = New-Object YeptWindow+RECT
[YeptWindow]::DwmGetWindowAttribute($h, 9, [ref]$frame, 16) | Out-Null
if ($Resize) {
  [YeptWindow]::ShowWindow($h, 9) | Out-Null
  [YeptWindow]::SetWindowPos($h, [IntPtr]::Zero, 40, 40, $Width, $Height, 0x0044) | Out-Null
  exit 0
}
if ($Click) {
  $x, $y = $Click.Split(',')
  [YeptWindow]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 300
  [YeptWindow]::SetCursorPos($frame.L + [int]$x, $frame.T + [int]$y) | Out-Null
  Start-Sleep -Milliseconds 100
  [YeptWindow]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
  [YeptWindow]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
  exit 0
}
$r = New-Object YeptWindow+RECT
[YeptWindow]::GetWindowRect($h, [ref]$r) | Out-Null
$bitmap = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$dc = $graphics.GetHdc()
# PW_RENDERFULLCONTENT captures Chromium content even when the window is covered.
[YeptWindow]::PrintWindow($h, $dc, 2) | Out-Null
$graphics.ReleaseHdc($dc)
$graphics.Dispose()
$crop = New-Object System.Drawing.Rectangle ($frame.L - $r.L), ($frame.T - $r.T), ($frame.R - $frame.L), ($frame.B - $frame.T)
$image = $bitmap.Clone($crop, $bitmap.PixelFormat)
$image.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"$($crop.Width)x$($crop.Height)"
