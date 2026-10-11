# Apply ForegroundLockTimeout = 0 to the CURRENT session, immediately.
#
# Why this exists: writing HKCU\Control Panel\Desktop\ForegroundLockTimeout is not enough.
# The value is cached per session, so a registry write does nothing until the next logon --
# and worse, Windows does not reliably consume that value at logon either, so even a reboot
# is not a guarantee. The supported way to change it live is SystemParametersInfo with
# SPI_SETFOREGROUNDLOCKTIMEOUT, which is what this does.
#
# Why it matters: with a non-zero timeout, Windows refuses to let Edge be forced into the
# foreground, so NVDA has nothing to read. The capture then returns 0 phrases with NO
# error anywhere -- nvda.start() succeeds, windowsActivate reports ok, and every read comes
# back empty. It is the single most misleading failure in the pipeline, and
# packages/nvda-worker/README.md calls it the #1 flakiness fix.
#
# MUST run in the interactive desktop session. Per the API docs, "the calling thread must
# be able to change the foreground window, otherwise the call fails" -- so running this as
# SYSTEM (e.g. via a guest agent, or a scheduled task without LogonType Interactive) will
# fail even though the registry write appears to succeed.
#
# Because the setting does not reliably survive a logon, this is called from BOTH
# provision-nvda-worker.ps1 (so a freshly provisioned box can capture without a reboot)
# and run-server.cmd (so every worker start re-applies it for that session).
#
# Style note: `#` line comments and no param() block, matching the other scripts here --
# see packages/worker-fleet/src/provisioning/diagnose-nvda-worker.ps1 for why.

$ErrorActionPreference = 'Stop'

if (-not ('A11y.Spi' -as [type])) {
  Add-Type -Namespace 'A11y' -Name 'Spi' -MemberDefinition @'
    // For SPI_SETFOREGROUNDLOCKTIMEOUT the new value is passed AS pvParam (the DWORD cast
    // to a pointer-sized value), not as a pointer to it. Getting this backwards silently
    // sets a garbage timeout.
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, UIntPtr pvParam, uint fWinIni);

    // For the GET action pvParam DOES point at a DWORD that receives the value.
    [DllImport("user32.dll", SetLastError = true, EntryPoint = "SystemParametersInfoW")]
    public static extern bool SystemParametersInfoGet(uint uiAction, uint uiParam, ref uint pvParam, uint fWinIni);
'@
}

$SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000
$SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001
$SPIF_UPDATEINIFILE           = 0x01   # persist into the user profile
$SPIF_SENDCHANGE              = 0x02   # broadcast WM_SETTINGCHANGE

$before = 0
[void][A11y.Spi]::SystemParametersInfoGet($SPI_GETFOREGROUNDLOCKTIMEOUT, 0, [ref] $before, 0)

$ok = [A11y.Spi]::SystemParametersInfo(
  $SPI_SETFOREGROUNDLOCKTIMEOUT, 0, [UIntPtr]::Zero,
  ($SPIF_UPDATEINIFILE -bor $SPIF_SENDCHANGE))
$err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()

$after = 0
[void][A11y.Spi]::SystemParametersInfoGet($SPI_GETFOREGROUNDLOCKTIMEOUT, 0, [ref] $after, 0)

# Belt and braces: also write the registry value so it is at least declared for future
# sessions. The API call above is what makes THIS session work.
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ForegroundLockTimeout -Value 0 -Type DWord -ErrorAction SilentlyContinue

if ($after -eq 0) {
  Write-Output "ForegroundLockTimeout: $before -> $after (applied to this session)"
  exit 0
}

Write-Output "ForegroundLockTimeout: still $after (SystemParametersInfo ok=$ok lastError=$err)"
Write-Output 'Most likely cause: not running in the interactive desktop session -- the API'
Write-Output 'requires a thread that is allowed to change the foreground window.'
exit 1
