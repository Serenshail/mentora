// 用 UI Automation 探查微信开发者工具窗口元素（只读）
const { execFileSync } = require("child_process");

const ps = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "项目列表")
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { "NO_WINDOW"; exit }
"WINDOW: " + $win.Current.Name + " | " + $win.Current.BoundingRectangle
$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
"COUNT: " + $all.Count
foreach ($e in $all) {
  $c = $e.Current
  if ($c.Name -and $c.ControlType.ProgrammaticName -match "Button|Hyperlink|Text|Menu|Tab") {
    $r = $c.BoundingRectangle
    "{0} | {1} | {2},{3} {4}x{5}" -f $c.ControlType.ProgrammaticName, $c.Name, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height
  }
}
`;

const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], {
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});
console.log(out);
