param([Parameter(Mandatory=$true)][string]$AppPath, [Parameter(Mandatory=$true)][string]$Evidence, [string]$RetainedText)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class UpdatedStudioWindow {
 [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 public static void Capture(IntPtr h,string path) { Rect r; if(!GetWindowRect(h,out r)) throw new Exception("No updated window bounds"); using(var b=new Bitmap(r.Right-r.Left,r.Bottom-r.Top)) { using(var g=Graphics.FromImage(b)) { var dc=g.GetHdc(); try { if(!PrintWindow(h,dc,2)) throw new Exception("Updated window capture failed"); } finally { g.ReleaseHdc(dc); } } b.Save(path,System.Drawing.Imaging.ImageFormat.Png); } }
}
'@
$deadline=(Get-Date).AddMinutes(3)
$app=$null
$names=@()
do {
 $app=Get-Process -Name 'AgentKit Studio' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $AppPath -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
 if($app) {
  $element=[System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
  $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'Agents')
  $navigation=$element.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
  if($navigation) {
   $elements=$element.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
   $names=@($elements | ForEach-Object {$_.Current.Name})
   if(-not $RetainedText -or ($names | Where-Object {$_ -like "*$RetainedText*"})) {break}
  }
 }
 Start-Sleep -Milliseconds 500
} while((Get-Date) -lt $deadline)
if(-not $app -or -not $navigation) {throw 'Automatically restarted installed App did not render Studio navigation'}
if($env:STUDIO_UPDATE_BASELINE_PID -and $app.Id -eq [int]$env:STUDIO_UPDATE_BASELINE_PID) {throw 'Updated App did not create a new process'}
if($RetainedText -and -not ($names | Where-Object {$_ -like "*$RetainedText*"})) {throw 'Retained conversation was not visible in the automatically restarted App'}
$signature=Get-AuthenticodeSignature $AppPath
if($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) {throw 'Updated executable signature is invalid'}
[UpdatedStudioWindow]::Capture($app.MainWindowHandle,(Join-Path $Evidence 'windows-updated-app.png'))
[ordered]@{actualAutoRestartedApp=$true;pid=$app.Id;path=$app.Path;studioNavigationVerified=$true;retainedTextVerified=([bool]$RetainedText);signatureValid=$true;timestamped=$true} | ConvertTo-Json | Set-Content (Join-Path $Evidence 'windows-updated-app.json')
& taskkill.exe /PID $app.Id /T /F | Out-Null
if ($LASTEXITCODE) {throw 'Updated App process-tree cleanup failed'}
