param([Parameter(Mandatory=$true)][string]$Evidence)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$desktop=[System.Windows.Automation.AutomationElement]::RootElement
$buttons=$desktop.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button))
$chevron=$buttons | Where-Object {$_.Current.Name -match '^(Show hidden icons|Hidden icon menu)$'} | Select-Object -First 1
if($chevron) {
  $invoke=$null
  if($chevron.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)) {$invoke.Invoke();Start-Sleep -Milliseconds 300}
}
$bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$height=[Math]::Min(400,$bounds.Height)
$width=[Math]::Min(800,$bounds.Width)
$bitmap=[System.Drawing.Bitmap]::new($width,$height)
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Right-$width,$bounds.Bottom-$height,0,0,$bitmap.Size)
  $bitmap.Save((Join-Path $Evidence 'windows-native-tray.png'),[System.Drawing.Imaging.ImageFormat]::Png)
} finally {$graphics.Dispose();$bitmap.Dispose()}
