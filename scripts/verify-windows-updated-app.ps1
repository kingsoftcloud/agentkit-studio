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
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
 public static void Click(IntPtr h,double x,double y) {SetForegroundWindow(h);SetCursorPos((int)x,(int)y);mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);}
 public static void Capture(IntPtr h,string path) { Rect r; if(!GetWindowRect(h,out r)) throw new Exception("No updated window bounds"); using(var b=new Bitmap(r.Right-r.Left,r.Bottom-r.Top)) { using(var g=Graphics.FromImage(b)) { var dc=g.GetHdc(); try { if(!PrintWindow(h,dc,2)) throw new Exception("Updated window capture failed"); } finally { g.ReleaseHdc(dc); } } b.Save(path,System.Drawing.Imaging.ImageFormat.Png); } }
}
'@
$deadline=(Get-Date).AddMinutes(3)
$app=$null
$names=@()
do {
 $app=Get-Process -Name 'AgentKit Studio' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $AppPath -and $_.MainWindowHandle -ne 0 -and (-not $env:STUDIO_UPDATE_BASELINE_PID -or $_.Id -ne [int]$env:STUDIO_UPDATE_BASELINE_PID) } | Select-Object -First 1
 if($app) {
  try {
  $element=[System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
  $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'Agents')
  $navigation=$element.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
  if($navigation) {
   $elements=$element.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
   $names=@($elements | ForEach-Object {$_.Current.Name})
   if(-not $RetainedText -or ($names | Where-Object {$_ -like "*$RetainedText*"})) {break}
  }
  } catch {
   # NSIS may replace a transient startup HWND while the successor is opening.
   # Reacquire the process/window within the deadline; never relaunch the App.
   $navigation=$null
   $names=@()
  }
 }
 Start-Sleep -Milliseconds 500
} while((Get-Date) -lt $deadline)
if(-not $app -or -not $navigation) {throw 'Automatically restarted installed App did not render Studio navigation'}
if($env:STUDIO_UPDATE_BASELINE_PID -and $app.Id -eq [int]$env:STUDIO_UPDATE_BASELINE_PID) {throw 'Updated App did not create a new process'}
if($RetainedText -and -not ($names | Where-Object {$_ -like "*$RetainedText*"})) {throw 'Retained conversation was not visible in the automatically restarted App'}
if($RetainedText) {
 $row=$elements | Where-Object { $_.Current.Name -like "$RetainedText*" -and -not $_.Current.IsOffscreen } | Select-Object -First 1
 if(-not $row) {throw 'Retained conversation row could not be opened'}
 $bounds=$row.Current.BoundingRectangle
 [UpdatedStudioWindow]::Click($app.MainWindowHandle,$bounds.X+$bounds.Width/2,$bounds.Y+$bounds.Height/2)
 $contentDeadline=(Get-Date).AddSeconds(60)
 do {
  $elements=$element.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $names=@($elements | ForEach-Object {$_.Current.Name})
  $userRetained=[bool]($names | Where-Object {$_ -eq 'Windows upgrade marker: retain this conversation after restarting.'})
  $replyRetained=[bool]($names | Where-Object {$_ -eq 'Windows upgrade marker saved.'})
  if($userRetained -and $replyRetained) {break}
  Start-Sleep -Milliseconds 500
 } while((Get-Date) -lt $contentDeadline)
 if(-not $userRetained -or -not $replyRetained) {throw 'Original user message and assistant reply were not retained after native restart'}
}
$signature=Get-AuthenticodeSignature $AppPath
if($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) {throw 'Updated executable signature is invalid'}
[UpdatedStudioWindow]::Capture($app.MainWindowHandle,(Join-Path $Evidence 'windows-updated-app.png'))
# Exercise the updated client after the native restart, using the retained profile.
$resourceCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'资源库')
$resource=$element.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$resourceCondition)
if(-not $resource -or $resource.Current.IsOffscreen) {throw 'Updated resource library navigation is unavailable'}
$bounds=$resource.Current.BoundingRectangle
[UpdatedStudioWindow]::Click($app.MainWindowHandle,$bounds.X+$bounds.Width/2,$bounds.Y+$bounds.Height/2)
$resourceDeadline=(Get-Date).AddSeconds(60)
do {
 $skillCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'Skill')
 $skill=$element.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$skillCondition)
 if($skill -and -not $skill.Current.IsOffscreen) {break}
 Start-Sleep -Milliseconds 500
} while((Get-Date) -lt $resourceDeadline)
if(-not $skill -or $skill.Current.IsOffscreen) {throw 'Updated Skill tab is unavailable'}
$bounds=$skill.Current.BoundingRectangle
[UpdatedStudioWindow]::Click($app.MainWindowHandle,$bounds.X+$bounds.Width/2,$bounds.Y+$bounds.Height/2)
$sourceCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'Skill 来源')
do {
 $source=$element.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$sourceCondition)
 if($source -and -not $source.Current.IsOffscreen) {break}
 Start-Sleep -Milliseconds 500
} while((Get-Date) -lt $resourceDeadline)
if(-not $source -or $source.Current.IsOffscreen) {throw 'Updated Skill source filter is unavailable'}
$centerCondition=[System.Windows.Automation.AndCondition]::new(
 [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'Skill Center'),
 [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button))
if($element.FindAll([System.Windows.Automation.TreeScope]::Descendants,$centerCondition).Count -ne 0) {throw 'Duplicate Skill Center tab remains in the updated client'}
[UpdatedStudioWindow]::Capture($app.MainWindowHandle,(Join-Path $Evidence 'windows-updated-resources.png'))
[ordered]@{actualAutoRestartedApp=$true;pid=$app.Id;path=$app.Path;studioNavigationVerified=$true;retainedTextVerified=([bool]$RetainedText);originalUserMessageRetained=([bool]$userRetained);originalAssistantReplyRetained=([bool]$replyRetained);signatureValid=$true;timestamped=$true;updatedSkillSourceFilterVerified=$true;duplicateSkillCenterTabAbsent=$true} | ConvertTo-Json | Set-Content (Join-Path $Evidence 'windows-updated-app.json')
& taskkill.exe /PID $app.Id /T /F | Out-Null
if ($LASTEXITCODE) {throw 'Updated App process-tree cleanup failed'}
