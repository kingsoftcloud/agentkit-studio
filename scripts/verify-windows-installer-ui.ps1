param([Parameter(Mandatory=$true)][string]$Installer, [Parameter(Mandatory=$true)][string]$Evidence)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Text;
using System.Drawing;
using System.Runtime.InteropServices;
public static class StudioInstallerWindow {
  public delegate bool Callback(IntPtr hwnd, IntPtr unused);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr unused);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, Callback cb, IntPtr unused);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  public static IntPtr Window(int pid) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((h, u) => { uint p; GetWindowThreadProcessId(h,out p); if(p==pid && IsWindowVisible(h)) found=h; return true; },IntPtr.Zero);
    return found;
  }
  public static IntPtr Control(IntPtr parent, string name) {
    IntPtr found=IntPtr.Zero;
    EnumChildWindows(parent,(h,u)=> { var s=new StringBuilder(256); GetWindowText(h,s,256); if(IsWindowVisible(h) && s.ToString()==name) found=h; return true; },IntPtr.Zero);
    return found;
  }
  public static void Capture(IntPtr hwnd, string path, bool requireBrand) {
    Rect r; if(!GetWindowRect(hwnd,out r)) throw new Exception("Window bounds unavailable");
    using(var bitmap=new Bitmap(r.Right-r.Left,r.Bottom-r.Top)) {
      using(var graphics=Graphics.FromImage(bitmap)) { var dc=graphics.GetHdc(); try { if(!PrintWindow(hwnd,dc,2)) throw new Exception("Native window capture failed"); } finally { graphics.ReleaseHdc(dc); } }
      bitmap.Save(path,System.Drawing.Imaging.ImageFormat.Png);
      if(requireBrand) {
        int blue=0,cyan=0;
        for(int y=bitmap.Height/4;y<bitmap.Height*2/3;y++) for(int x=bitmap.Width/3;x<bitmap.Width*2/3;x++) {
          var c=bitmap.GetPixel(x,y);
          if(c.B>160 && c.R<60 && c.G>55 && c.G<140) blue++;
          if(c.R>70 && c.R<160 && c.G>190 && c.B>195) cyan++;
        }
        if(blue<200 || cyan<10) throw new Exception("Installer still lacks the Nexus blue/cyan product mark");
      }
    }
  }
}
'@
$destination = Join-Path $env:RUNNER_TEMP 'studio-visible-installed-proof'
$env:DSH_HOME = Join-Path $env:RUNNER_TEMP 'studio-finish-shared-dsh'
$env:AGENTKIT_HOME = Join-Path $env:RUNNER_TEMP 'studio-finish-agentkit'
$env:DSH_TELEMETRY_DISABLED = '1'
$install = Start-Process -FilePath $Installer -ArgumentList "/D=$destination" -PassThru
$started = $null
try {
  $deadline = (Get-Date).AddMinutes(3)
  do {
    $window = [StudioInstallerWindow]::Window($install.Id)
    $button = [StudioInstallerWindow]::Control($window, 'Install now')
    if ($button -eq [IntPtr]::Zero) { $button = [StudioInstallerWindow]::Control($window, '立即安装') }
    if ($button -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline -and -not $install.HasExited)
  if ($button -eq [IntPtr]::Zero) { throw 'Visible installation page did not appear' }
  [StudioInstallerWindow]::Capture($window, (Join-Path $Evidence 'windows-installer-welcome.png'), $true)
  [StudioInstallerWindow]::PostMessage($button, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  $deadline = (Get-Date).AddMinutes(5)
  do {
    $window = [StudioInstallerWindow]::Window($install.Id)
    $finish = [StudioInstallerWindow]::Control($window, 'Finish')
    if ($finish -eq [IntPtr]::Zero) { $finish = [StudioInstallerWindow]::Control($window, '完成') }
    if ($finish -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline -and -not $install.HasExited)
  if ($finish -eq [IntPtr]::Zero) { throw 'Installation finish page did not appear' }
  [StudioInstallerWindow]::Capture($window, (Join-Path $Evidence 'windows-installer-finish.png'), $true)
  [StudioInstallerWindow]::PostMessage($finish, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  if (-not $install.WaitForExit(30000) -or $install.ExitCode -ne 0) { throw 'Finish action failed' }
  $appPath = Join-Path $destination 'AgentKit Studio.exe'
  $deadline = (Get-Date).AddMinutes(3)
  do {
    $started = Get-Process -Name 'AgentKit Studio' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $appPath -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($started) {
      $element = [System.Windows.Automation.AutomationElement]::FromHandle($started.MainWindowHandle)
      $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'Agents')
      $navigation = $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
      if ($navigation) { break }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  if (-not $started -or -not $navigation) { throw 'Finish Launch now did not render Studio Agents navigation in the installed process' }
  [StudioInstallerWindow]::Capture($started.MainWindowHandle, (Join-Path $Evidence 'windows-installer-launched-app.png'), $false)
  [ordered]@{installerBrandVerified=$true;visibleInstallation=$true;finishLaunchVerified=$true;studioNavigationVerified=$true;installedPath=$appPath;pid=$started.Id} | ConvertTo-Json | Set-Content (Join-Path $Evidence 'windows-installer-ui.json')
} finally {
  if ($started -and -not $started.HasExited) { Stop-Process -Id $started.Id -Force }
  if (-not $install.HasExited) { Stop-Process -Id $install.Id -Force }
}
