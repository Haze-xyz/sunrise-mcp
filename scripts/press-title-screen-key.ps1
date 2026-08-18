<#
  Presses a key on the game, with nobody at the keyboard. Two routes, tried in this order, and the
  result names the one that actually ran -- that name is what someone reads when this breaks again.

    1. SendInput  -- an OS-level keystroke. The only route measured to move this engine's title
                     screen. Injected ONLY after GetForegroundWindow() has been read back and
                     confirmed to be the game's own window.
    2. PostMessage -- WM_KEYDOWN/WM_KEYUP posted straight at the game's HWND. Needs no foreground.
                     Kept as a fallback for when the foreground cannot be taken; measured NOT to
                     move this engine's title screen, so it is a last resort, not an equal.

  ---------------------------------------------------------------------------------------------
  What was measured on 2026-08-18, with every Win32 return value actually read (Task 1, Step 1)
  ---------------------------------------------------------------------------------------------

  * The old spelling of the INPUT struct was silently empty. This script used to say

        $down.ki = New-Object SunriseSendInput+KEYBDINPUT
        $down.ki.wVk = [uint16]$Vk

    PowerShell hands back a boxed COPY when you read a value-type field, so `.wVk = 13` lands on
    that copy and is thrown away. Marshalling the resulting INPUT to bytes gives
    `type=1 wVk=0 wScan=0`: a null keystroke, which the OS accepts and returns 1 for, and which no
    application can act on. Every SendInput this project ever issued was that null keystroke. Build
    the KEYBDINPUT in its own variable and assign it to `.ki` whole, as below -- and the readback
    guard further down fails the call loudly rather than injecting nothing if that ever regresses.

  * SetForegroundWindow really does fail from here, but that was not the bug. Called on the game's
    window from a PowerShell started out of WSL it returned False and GetForegroundWindow() was
    unchanged (it stayed on the user's browser). The old code discarded that False. Restoring the
    window from a minimized state, however, does activate it, and Windows permits that -- which is
    why the sequence below is minimize -> restore -> SetForegroundWindow rather than a bare
    SetForegroundWindow.

  * The engine does not read the window message queue for this key. PostMessage and SendMessage of
    WM_KEYDOWN/WM_KEYUP/WM_CHAR, to the visible 'Tiger D3D Window', to the hidden 'Tiger Input
    Window' the process also owns, and to both windows' thread queues via PostThreadMessage, all
    returned success and none dismissed the title screen -- with or without a faked
    WM_ACTIVATE/WM_SETFOCUS first.

    The cause is now known by name, from static analysis of the mapped dump rather than inferred
    from the behaviour: the engine polls **GetKeyState** (`Input_PollKeyboardState105`, RVA
    0x003447A0). GetKeyState reads the per-thread SYNCHRONOUS key-state table, which is updated
    only when that thread pulls real hardware input off its queue. A posted message never touches
    it -- which is why no PostMessage, SendMessage or PostThreadMessage can move this screen, at
    any window, on any thread -- and injected input only ever reaches the FOREGROUND thread's
    queue. Both negatives below follow mechanically from that one fact. (An earlier revision of
    this comment guessed "Raw Input or DirectInput". Every behavioural conclusion survived; the
    attributed API did not. The right name matters: the follow-on route is Sunrise's own hook
    intercepting that polled GetKeyState in-process, which is discoverable from `GetKeyState` and
    invisible from `RegisterRawInputDevices`.)

  * With the struct fixed, SendInput dismisses the title screen instantly when the game holds the
    foreground, and does nothing at all when it does not. Both directions were measured on the same
    launch. So the foreground is genuinely required -- but only for the two doors this script has:
    FROM OUTSIDE THE PROCESS, VIA SendInput OR PostMessage. It is not a closed problem in general.
    Two other doors meet the no-foreground condition and are out of this script's scope: hooking
    the very GetKeyState the engine polls, in-process (Sunrise's own forced-key hook), and a
    separate desktop via CreateDesktop/SetThreadDesktop, which has its own foreground that never
    touches the user's screen.

  ---------------------------------------------------------------------------------------------
  Why this is still better than what layer 2 accepted
  ---------------------------------------------------------------------------------------------

  Layer 2 knowingly accepted that SendInput goes to whatever window has focus, so a press could
  land in whatever the user had alt-tabbed to. That defect is gone: the keystroke is injected only
  once GetForegroundWindow() has been read and found to be the game's window, and if the foreground
  cannot be obtained this script does not inject at all -- it falls back to PostMessage, which
  targets a HWND and so cannot leak anywhere either. Either way, nothing is ever typed into a
  window that is not the game's.

  What it costs instead: the game window is pulled to the front, and the window the user was on is
  NOT put back (see "What this disturbs" below). There is no way around the foreground for the two
  routes this script has, and it needs no human -- which is the property that actually matters here.

  ---------------------------------------------------------------------------------------------
  What this disturbs, and what it does not put back
  ---------------------------------------------------------------------------------------------

  Taking the foreground means SW_MINIMIZE on the game window (which activates whatever is next in
  the Z order) and then SW_RESTORE + SetForegroundWindow to pull the game in front. The window the
  user was on is left behind the game and is deliberately NOT restored: this script cannot verify a
  restore against a live game in the session that added this note, and an unverified focus change on
  the critical path is a worse bet than the disturbance it would undo -- the caller asked for the
  game to be driven, and the game is what it gets. The result JSON reports what was displaced
  (`foregroundBefore`) and whether this script minimized anything (`minimized`), so nothing about it
  is silent.

  Two things bound the damage. The minimize/restore pair polls IsIconic instead of sleeping a flat
  span, so the interval where the game is minimized is as short as Windows allows rather than a
  fixed 400ms; and if this script finds the game window ALREADY minimized on entry -- exactly the
  state a previous run killed at PRESS_KEY_TIMEOUT_MS between the two calls would leave -- it
  restores it and says so (`restoredIconicAtEntry`), so that hazard self-heals on the next call
  rather than needing a human.

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
public class SunriseKeyPress {
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
  // actually injecting anything. Measured against the real game: this cost an earlier probe two
  // attempts before the 40-byte layout below was found to be the fix. Do not "simplify" this.
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public KEYBDINPUT ki;
    public int pad1;
    public int pad2;
  }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint MapVirtualKeyW(uint uCode, uint uMapType);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool IsIconic(IntPtr hWnd);
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

# destiny2.exe owns two same-titled top-level windows: the visible 'Tiger D3D Window' (the
# renderer) and a hidden 'Tiger Input Window' parked off-screen on another thread. MainWindowHandle
# picks the visible one, which is the one measured to matter; the hidden one ignored every message
# sent to it. The handle is reported in the result so a future breakage shows which window was
# targeted rather than leaving that to be re-derived.
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Result @{ status = 'failed'; error = 'destiny2.exe is running but has no main window yet.' }
  exit 1
}

# ---------------------------------------------------------------- take the foreground, and check
$SW_MINIMIZE = 6
$SW_RESTORE = 9

# Record what we are about to displace, so the result can say it rather than leaving the user to
# work out why their window went behind the game.
$foregroundBefore = [SunriseKeyPress]::GetForegroundWindow()
$foregroundBeforeText = ('0x{0:X}' -f $foregroundBefore.ToInt64())

# Self-heal: a run killed at PRESS_KEY_TIMEOUT_MS between the minimize and the restore below leaves
# the game minimized in a state this script created. Undo that on entry rather than pressing into
# it, and report having done so.
$restoredIconicAtEntry = $false
if ([SunriseKeyPress]::IsIconic($hwnd)) {
  [void][SunriseKeyPress]::ShowWindow($hwnd, $SW_RESTORE)
  $restoredIconicAtEntry = $true
  Start-Sleep -Milliseconds 300
}

$alreadyForeground = ([SunriseKeyPress]::GetForegroundWindow() -eq $hwnd)
$setForegroundResult = $null
$minimized = $false
if (-not $alreadyForeground) {
  # A bare SetForegroundWindow is refused (measured: False, foreground unchanged) because this
  # process is not in the foreground and has had no user input. Restoring a minimized window
  # activates it, and that path Windows does allow.
  #
  # Poll IsIconic rather than sleeping a flat 400ms: this is the interval in which the game sits
  # minimized, and it is also the interval in which a killed script strands it there, so it is kept
  # to whatever Windows actually needs instead of a guessed worst case.
  [void][SunriseKeyPress]::ShowWindow($hwnd, $SW_MINIMIZE)
  $minimized = $true
  for ($i = 0; $i -lt 12; $i++) {
    if ([SunriseKeyPress]::IsIconic($hwnd)) { break }
    Start-Sleep -Milliseconds 50
  }
  [void][SunriseKeyPress]::ShowWindow($hwnd, $SW_RESTORE)
  [void][SunriseKeyPress]::BringWindowToTop($hwnd)
  $setForegroundResult = [SunriseKeyPress]::SetForegroundWindow($hwnd)
}

# True when this invocation activated the game window itself -- by the entry self-heal, by the
# minimize/restore dance, or both -- as opposed to finding it already in front and untouched. This
# is what the settle below keys on; see the comment there.
$activatedByThisScript = ($restoredIconicAtEntry -or $minimized)

# Poll rather than sleep a guessed span: activation is asynchronous, and this is the one fact the
# whole SendInput branch is gated on, so it is read from Windows instead of assumed.
$foregroundIsGame = $false
for ($i = 0; $i -lt 8; $i++) {
  if ([SunriseKeyPress]::GetForegroundWindow() -eq $hwnd) { $foregroundIsGame = $true; break }
  Start-Sleep -Milliseconds 250
}

# Windows saying the window is foreground is not the same as the engine having re-acquired the
# keyboard. Measured: pressing the instant GetForegroundWindow() first agreed, right after the
# minimize/restore above, was accepted by the OS (down=1 up=1) and ignored by the game, which then
# sat on the title screen until game_enter's world-load wait timed out. The same keystroke against
# the same window a few seconds later worked immediately. 1200ms is the settle that was measured
# working across the restore, so it is the number used rather than a rounder guess; then the
# foreground is read once more, since anything could have taken it back during the wait.
#
# Gated on whether THIS script changed the window's activation state, not on $alreadyForeground.
# The self-heal above is an activation too: measured against the real game, SW_RESTORE on a window
# a different (already-dead) process had minimized wins the foreground outright, so $alreadyForeground
# comes back TRUE and the minimize/restore branch never runs. Reading $alreadyForeground alone would
# therefore skip the settle on exactly the path that just activated the window, leaving only the
# 300ms above between activation and the keystroke -- a quarter of the settle that was measured to
# be necessary. It happened to work twice; that is luck, not a margin.
if ($activatedByThisScript -and $foregroundIsGame) {
  Start-Sleep -Milliseconds 1200
  $foregroundIsGame = ([SunriseKeyPress]::GetForegroundWindow() -eq $hwnd)
}

# ---------------------------------------------------------------- route 1: SendInput
if ($foregroundIsGame) {
  $scan = [SunriseKeyPress]::MapVirtualKeyW([uint32]$Vk, 0)  # MAPVK_VK_TO_VSC

  # Build each KEYBDINPUT in its own variable and assign it to .ki WHOLE -- see the header comment
  # for what writing `$down.ki.wVk = ...` instead actually does.
  $downKey = New-Object SunriseKeyPress+KEYBDINPUT
  $downKey.wVk = [uint16]$Vk
  $downKey.wScan = [uint16]$scan
  $downKey.dwFlags = [uint32]0

  $upKey = New-Object SunriseKeyPress+KEYBDINPUT
  $upKey.wVk = [uint16]$Vk
  $upKey.wScan = [uint16]$scan
  $upKey.dwFlags = [uint32]0x0002  # KEYEVENTF_KEYUP

  $down = New-Object SunriseKeyPress+INPUT
  $down.type = 1  # INPUT_KEYBOARD
  $down.ki = $downKey

  $up = New-Object SunriseKeyPress+INPUT
  $up.type = 1
  $up.ki = $upKey

  # Read the key code back out of the struct that is about to be marshalled. This is the check the
  # old code did not have: the copy-assignment bug it guards against produced wVk = 0, a keystroke
  # the OS reports as delivered (SendInput returns 1) and nothing on the machine responds to, which
  # is indistinguishable from "the game ignored us" unless someone dumps the bytes.
  if ($down.ki.wVk -ne [uint16]$Vk -or $up.ki.wVk -ne [uint16]$Vk) {
    Write-Result @{
      status = 'failed'
      route = 'sendInput'
      hwnd = ('0x{0:X}' -f $hwnd.ToInt64())
      error = ('the INPUT struct came out with wVk={0} instead of {1}; SendInput would have ' -f @($down.ki.wVk, $Vk)) +
              'injected a null keystroke. See this script''s header comment.'
    }
    exit 1
  }

  $size = [Runtime.InteropServices.Marshal]::SizeOf([Type]([SunriseKeyPress+INPUT]))
  $downCount = [SunriseKeyPress]::SendInput(1, @($down), $size)
  Start-Sleep -Milliseconds $HoldMs
  $upCount = [SunriseKeyPress]::SendInput(1, @($up), $size)

  Write-Result @{
    status = 'sent'
    route = 'sendInput'
    hwnd = ('0x{0:X}' -f $hwnd.ToInt64())
    foregroundBefore = $foregroundBeforeText
    restoredIconicAtEntry = $restoredIconicAtEntry
    minimized = $minimized
    alreadyForeground = $alreadyForeground
    setForegroundResult = $setForegroundResult
    # The measured variable, never the literal $true the enclosing branch would make "true anyway".
    # This is the one field the whole no-leak argument rests on; it must not be able to lie, and a
    # future edit that moves this write outside the branch must not silently turn it into a claim.
    foregroundIsGame = $foregroundIsGame
    down = $downCount
    up = $upCount
  }
  exit 0
}

# ---------------------------------------------------------------- route 2: PostMessage fallback
# The game never came to the front, so injecting an OS keystroke now would type into whatever the
# user is actually looking at. Post to the HWND instead: it reaches this window or nothing.
$WM_KEYDOWN = 0x0100
$WM_KEYUP = 0x0101
$scanForLParam = [int64]([SunriseKeyPress]::MapVirtualKeyW([uint32]$Vk, 0) -band 0xFF)
# lParam: repeat count 1 in bits 0-15, scan code in bits 16-23. The key-up form adds bit 30 (the
# key was previously down) and bit 31 (this is a release), as a real release carries -- written as
# the decimal 3221225472 because PowerShell parses the hex literal 0xC0000000 as a negative Int32.
$lParamDownValue = ($scanForLParam * 65536) + 1
$lParamDown = [IntPtr]::new($lParamDownValue)
$lParamUp = [IntPtr]::new($lParamDownValue + 3221225472)

$postedDown = [SunriseKeyPress]::PostMessage($hwnd, $WM_KEYDOWN, [IntPtr]$Vk, $lParamDown)
Start-Sleep -Milliseconds $HoldMs
$postedUp = [SunriseKeyPress]::PostMessage($hwnd, $WM_KEYUP, [IntPtr]$Vk, $lParamUp)

$postStatus = 'failed'
if ($postedDown -and $postedUp) { $postStatus = 'sent' }

Write-Result @{
  status = $postStatus
  route = 'postMessage'
  hwnd = ('0x{0:X}' -f $hwnd.ToInt64())
  foregroundBefore = $foregroundBeforeText
  restoredIconicAtEntry = $restoredIconicAtEntry
  minimized = $minimized
  alreadyForeground = $alreadyForeground
  setForegroundResult = $setForegroundResult
  foregroundIsGame = $foregroundIsGame
  postedDown = $postedDown
  postedUp = $postedUp
}
if ($postedDown -and $postedUp) { exit 0 } else { exit 1 }
