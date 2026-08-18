<#
  Presses a key against the game's foreground window via the Win32 SendInput API.

  This is the one place in the whole Sunrise MCP project where SendInput is the right tool.
  Everywhere else, key input is meant to reach the game through the DLL's own hook -- but a probe
  run against the real game on 2026-08-18 measured that the hook does NOT reach the title screen
  (holding VK_RETURN through it for three seconds moved nothing), while SendInput worked immediately
  and the game went on to load all the way to "successfully changed world to: orbit_d2". The title
  screen precedes every hook this project installs, so an OS-level keystroke is the only door open
  there. SendInput goes to whatever window currently has OS foreground focus, not to a specific one,
  so using it anywhere else would leak keystrokes into whatever the user has alt-tabbed to; it is
  acceptable here only because the title screen is on screen for a few seconds right at startup.

  Emits exactly one line of JSON on stdout via [Console]::Out.WriteLine, mirroring launch-game.ps1:
  Write-Output routes through PowerShell's success-stream formatter, which wraps long lines at the
  console width, and a caller that reads only the last line of output would then get a fragment
  instead of the whole JSON object.
#>
param(
  [int] $Vk = 13,
  [int] $HoldMs = 250
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SunriseSendInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  // INPUT is 40 bytes on x64. A declaration missing the two trailing int fields comes out 32
  // bytes, and SendInput then silently returns 0 -- no exception, no useful error -- instead of
  // actually injecting anything. Measured against the real game: this cost the probe two attempts
  // before the 40-byte layout below was found to be the fix. Do not "simplify" this struct.
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public KEYBDINPUT ki;
    public int pad1;
    public int pad2;
  }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

function Write-Result($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
}

$proc = Get-Process destiny2 -ErrorAction SilentlyContinue
if (-not $proc) {
  Write-Result @{ status = 'no-game' }
  exit 1
}

[void][SunriseSendInput]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 400

$size = [Runtime.InteropServices.Marshal]::SizeOf([Type]([SunriseSendInput+INPUT]))

$down = New-Object SunriseSendInput+INPUT
$down.type = 1
$down.ki = New-Object SunriseSendInput+KEYBDINPUT
$down.ki.wVk = [uint16]$Vk

$up = New-Object SunriseSendInput+INPUT
$up.type = 1
$up.ki = New-Object SunriseSendInput+KEYBDINPUT
$up.ki.wVk = [uint16]$Vk
$up.ki.dwFlags = 0x0002  # KEYEVENTF_KEYUP

$downCount = [SunriseSendInput]::SendInput(1, @($down), $size)
Start-Sleep -Milliseconds $HoldMs
$upCount = [SunriseSendInput]::SendInput(1, @($up), $size)

Write-Result @{ status = 'sent'; down = $downCount; up = $upCount }
exit 0
