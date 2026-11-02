// 屏幕坐标点击/输入（Windows）：node scripts/mp-click.cjs click X Y | type "text" | key ENTER
const { execFileSync } = require("child_process");
const [cmd, ...args] = process.argv.slice(2);

const ps = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte scan,uint f,int e);
}
'@
function Click($x,$y){
  [M]::SetCursorPos([int]$x,[int]$y); Start-Sleep -Milliseconds 150
  [M]::mouse_event(0x0002,0,0,0,0); Start-Sleep -Milliseconds 60
  [M]::mouse_event(0x0004,0,0,0,0)
}
function Tap($x,$y){
  [M]::SetCursorPos([int]$x,[int]$y); Start-Sleep -Milliseconds 120
  [M]::mouse_event(0x0002,0,0,0,0); Start-Sleep -Milliseconds 40
  [M]::mouse_event(0x0004,0,0,0,0)
}
function TypeText($t){
  $prev = [Console]::OutputEncoding
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait($t)
}
function PressKey($k){
  $map = @{ ENTER=13; TAB=9; ESC=27; DOWN=40; UP=38; LEFT=37; RIGHT=39; F5=116; CTRLA=65 }
  $vk = $map[$k]
  if ($k -eq 'CTRLA') {
    [M]::keybd_event(0x11,0,0,0); [M]::keybd_event(65,0,0,0); Start-Sleep -Milliseconds 60
    [M]::keybd_event(65,0,2,0); [M]::keybd_event(0x11,0,2,0)
  } else {
    [M]::keybd_event($vk,0,0,0); Start-Sleep -Milliseconds 50
    [M]::keybd_event($vk,0,2,0)
  }
}
switch ("${cmd}") {
  "click" { Click ${args[0] || 0} ${args[1] || 0}; "clicked ${args[0]},${args[1]}" }
  "tap"   { Tap ${args[0] || 0} ${args[1] || 0}; "tapped" }
  "type"  { TypeText "${(args[0] || "").replace(/"/g, '`"')}"; "typed" }
  "key"   { PressKey "${args[0] || "ENTER"}"; "key ${args[0]}" }
  default { "unknown" }
}
`;

const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], {
  encoding: "utf8",
});
process.stdout.write(out);
