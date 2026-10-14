param([Parameter(Mandatory=$true)][string]$AppPath, [Parameter(Mandatory=$true)][string]$Evidence, [switch]$Close)
$ErrorActionPreference='Stop'
if($Close) {
 Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $AppPath -and $_.MainWindowHandle -ne 0} | ForEach-Object {& taskkill.exe /PID $_.Id /T /F | Out-Null}
 exit 0
}
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class OfficialDshWindow {
 [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 public static void Capture(IntPtr h,string path) { Rect r; if(!GetWindowRect(h,out r)) throw new Exception("No official DSH window bounds"); using(var b=new Bitmap(r.Right-r.Left,r.Bottom-r.Top)) { using(var g=Graphics.FromImage(b)) { var dc=g.GetHdc(); try { if(!PrintWindow(h,dc,2)) throw new Exception("Official DSH window capture failed"); } finally { g.ReleaseHdc(dc); } } b.Save(path,System.Drawing.Imaging.ImageFormat.Png); } }
}
'@
$deadline=(Get-Date).AddMinutes(2)
do {
 $app=Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $AppPath -and $_.MainWindowHandle -ne 0} | Select-Object -First 1
 if($app) {break}
 Start-Sleep -Milliseconds 250
} while((Get-Date) -lt $deadline)
if(-not $app) {throw 'Normally launched official DSH did not show a real window'}
[OfficialDshWindow]::Capture($app.MainWindowHandle,(Join-Path $Evidence 'windows-real-official-dsh.png'))
[ordered]@{pid=$app.Id;path=$app.Path;realWindowVisible=$true} | ConvertTo-Json | Set-Content (Join-Path $Evidence 'windows-official-process.json')
