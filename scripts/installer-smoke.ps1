#requires -Version 7.0
param([switch]$SkipFullRegression, [switch]$InspectOnly)

$ErrorActionPreference = 'Stop'
$niriaWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$niriaArtifacts = Join-Path $niriaWorkspace 'artifacts'
$niriaRun = Join-Path $niriaArtifacts ('installer-smoke-' + [Guid]::NewGuid().ToString('N'))
$niriaInstall = Join-Path $niriaRun '安装测试 Install'
$niriaData = Join-Path $niriaRun 'data'
$niriaVersion = (Get-Content -LiteralPath (Join-Path $niriaWorkspace 'package.json') -Raw | ConvertFrom-Json).version
$niriaOldVersion = '0.14.0'
$niriaDefaultData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'niria'
$niriaSentinel = Join-Path $niriaDefaultData ('installer-check-' + [Guid]::NewGuid().ToString('N') + '.txt')
$niriaSentinelText = [Guid]::NewGuid().ToString('N')
$niriaLinks = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'NIRIA.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'NIRIA.lnk')
)
$niriaMayOwnInstall = $false
$niriaSentinelCreated = $false
$niriaReport = [ordered]@{ version = $niriaVersion; oldVersion = $niriaOldVersion; output = $niriaRun; phases = @(); ok = $false }

function Assert-Check([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}
function Assert-ArtifactPath([string]$Path) {
  $absolute = [IO.Path]::GetFullPath($Path)
  Assert-Check ($absolute.StartsWith($niriaArtifacts + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) "Path outside artifacts: $absolute"
  $part = $absolute
  while ($part.Length -ge $niriaArtifacts.Length) {
    if (Test-Path -LiteralPath $part) {
      Assert-Check (-not ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) "Reparse point in test path: $part"
    }
    $part = [IO.Path]::GetDirectoryName($part)
    if (-not $part) { break }
  }
}
function Get-NiriaRegistration {
  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  @(Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'NIRIA*' })
}
function Add-Phase([string]$Name, $Evidence) {
  $niriaReport.phases += [ordered]@{ phase = $Name; evidence = $Evidence }
  $niriaReport | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $niriaRun 'result.json') -Encoding utf8
  Write-Host "Verified: $Name"
}
function Wait-NiriaProcess($Process, [int]$Seconds = 150) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while (-not $Process.HasExited) {
    if ([DateTime]::UtcNow -gt $deadline) {
      # This is the exact child started by this test, never a name-based kill.
      $Process.Kill()
      throw "Timed out waiting for test process $($Process.Id)"
    }
    Start-Sleep -Milliseconds 200
    $Process.Refresh()
  }
  $Process.WaitForExit()
  Assert-Check ($Process.ExitCode -eq 0) "Test process exited with $($Process.ExitCode)"
}
function Assert-Sentinel {
  Assert-Check ((Test-Path -LiteralPath $niriaSentinel) -and
    [IO.File]::ReadAllText($niriaSentinel) -eq $niriaSentinelText) 'Default data directory sentinel was removed or changed'
}
function Assert-Install([string]$Version) {
  Assert-ArtifactPath $niriaInstall
  $records = @(Get-NiriaRegistration)
  Assert-Check ($records.Count -eq 1) 'Expected exactly one test installation registration'
  Assert-Check ($records[0].DisplayVersion -eq $Version) 'Registered version differs from installer version'
  $uninstaller = Join-Path $niriaInstall 'Uninstall NIRIA.exe'
  Assert-Check ($records[0].UninstallString.StartsWith('"' + $uninstaller + '"', [StringComparison]::OrdinalIgnoreCase)) 'Registration points outside test installation'
  Assert-Check (Test-Path -LiteralPath (Join-Path $niriaInstall 'NIRIA.exe')) 'Installed executable is missing'
  $shell = New-Object -ComObject WScript.Shell
  foreach ($link in $niriaLinks) {
    Assert-Check (Test-Path -LiteralPath $link) "Missing shortcut: $link"
    $target = $shell.CreateShortcut($link).TargetPath
    Assert-Check ($target -ieq (Join-Path $niriaInstall 'NIRIA.exe')) 'Shortcut points outside test installation'
  }
  Assert-Sentinel
}
function Install-Niria([string]$Version) {
  Assert-ArtifactPath $niriaInstall
  $installer = Join-Path $niriaWorkspace "release\NIRIA Setup $Version.exe"
  Assert-Check (Test-Path -LiteralPath $installer) "Missing installer: $installer"
  # NSIS consumes the unquoted remainder after /D=. It must be the last option.
  $process = Start-Process -FilePath $installer -ArgumentList "/S /currentuser /D=$niriaInstall" -WindowStyle Hidden -PassThru
  Wait-NiriaProcess $process
  Assert-Install $Version
  Add-Phase "install-$Version" @{ registration = $true; shortcuts = $true; customUnicodePath = $true; defaultDataSentinel = $true }
}
function Run-NativePhase([string]$Phase) {
  $result = Join-Path $niriaRun ("native-$Phase-" + [Guid]::NewGuid().ToString('N') + '.json')
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = Join-Path $niriaInstall 'NIRIA.exe'
  $info.WorkingDirectory = $niriaWorkspace
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $info.ArgumentList.Add('--smoke')
  $info.Environment['NIRIA_DESKTOP_DATA_DIR'] = $niriaData
  $info.Environment['NIRIA_SMOKE_PHASE'] = $Phase
  $info.Environment['NIRIA_SMOKE_RESULT'] = $result
  $info.Environment['NIRIA_SMOKE_SCREENSHOT'] = Join-Path $niriaRun 'installed.png'
  $process = [Diagnostics.Process]::Start($info)
  Wait-NiriaProcess $process 60
  $evidence = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
  Assert-Check $evidence.ok "Installed app failed phase $Phase"
  Add-Phase "native-$Phase" $evidence
}
function Uninstall-Niria {
  Assert-ArtifactPath $niriaInstall
  $records = @(Get-NiriaRegistration)
  Assert-Check ($records.Count -eq 1) 'Cannot safely identify test installation for cleanup'
  $uninstaller = Join-Path $niriaInstall 'Uninstall NIRIA.exe'
  Assert-Check ($records[0].UninstallString.StartsWith('"' + $uninstaller + '"', [StringComparison]::OrdinalIgnoreCase)) 'Refusing to uninstall another installation'
  # Running the identical uninstaller outside its own directory lets NSIS remove
  # that directory completely. Do not pass --delete-app-data or /KEEP_APP_DATA.
  $runner = Join-Path $niriaRun ('uninstall-' + [Guid]::NewGuid().ToString('N') + '.exe')
  Copy-Item -LiteralPath $uninstaller -Destination $runner
  Assert-Check ((Get-FileHash -LiteralPath $runner).Hash -eq (Get-FileHash -LiteralPath $uninstaller).Hash) 'Uninstaller copy differs'
  $before = (Get-FileHash -LiteralPath (Join-Path $niriaData 'companion.sqlite')).Hash
  $process = Start-Process -FilePath $runner -ArgumentList "/S /currentuser _?=$niriaInstall" -WindowStyle Hidden -PassThru
  Wait-NiriaProcess $process
  Assert-Check (-not (Test-Path -LiteralPath $niriaInstall)) 'Installation directory remains after uninstall'
  Assert-Check (@(Get-NiriaRegistration).Count -eq 0) 'Uninstall registration remains'
  foreach ($link in $niriaLinks) { Assert-Check (-not (Test-Path -LiteralPath $link)) 'Test shortcut remains' }
  Assert-Sentinel
  Assert-Check ((Get-FileHash -LiteralPath (Join-Path $niriaData 'companion.sqlite')).Hash -eq $before) 'Companion database changed during uninstall'
  Add-Phase 'uninstall' @{ removedProgram = $true; removedRegistration = $true; removedShortcuts = $true; defaultDataSentinel = $true; isolatedDatabaseUnchanged = $true; databaseSha256 = $before }
}

try {
  Assert-Check ($IsWindows -or $env:OS -eq 'Windows_NT') 'Windows is required'
  Assert-ArtifactPath $niriaRun
  Assert-Check (@(Get-NiriaRegistration).Count -eq 0) 'Existing NIRIA installation detected; test did not modify it'
  Assert-Check (@(Get-Process -Name NIRIA -ErrorAction SilentlyContinue).Count -eq 0) 'Close NIRIA before installer testing'
  foreach ($link in $niriaLinks) { Assert-Check (-not (Test-Path -LiteralPath $link)) 'Existing shortcut detected; test did not modify it' }
  foreach ($name in @('companion.sqlite', 'credentials.sqlite', 'desktop.json')) {
    Assert-Check (-not (Test-Path -LiteralPath (Join-Path $niriaDefaultData $name))) 'Existing default companion data detected; test did not modify it'
  }
  $fixtureFile = Join-Path $niriaArtifacts 'storage-v2-upgrade-fixture.json'
  $fixture = Get-Content -LiteralPath $fixtureFile -Raw | ConvertFrom-Json
  Assert-Check ($fixture.oldVersion -eq $niriaOldVersion) 'Unexpected legacy fixture version'
  foreach ($name in @('companion.sqlite', 'upgrade-expected.json', 'legacy-backup.niria')) {
    Assert-Check (Test-Path -LiteralPath (Join-Path $fixture.dataDirectory $name)) "Missing legacy fixture: $name"
  }
  $installers = @(foreach ($version in @($niriaOldVersion, $niriaVersion)) {
    $installer = Join-Path $niriaWorkspace "release\NIRIA Setup $version.exe"
    Assert-Check (Test-Path -LiteralPath $installer) "Missing installer: $installer"
    $integrity = & node --input-type=module -e 'import{readFileSync}from"node:fs";import{pathToFileURL}from"node:url";const{verifyNsisCrc}=await import(pathToFileURL(process.argv[1]));console.log(JSON.stringify(verifyNsisCrc(readFileSync(process.argv[2]))));' (Join-Path $niriaWorkspace 'scripts\nsis-integrity.mjs') $installer
    Assert-Check ($LASTEXITCODE -eq 0) "Installer CRC verification failed: $version"
    [ordered]@{ version = $version; file = $installer; bytes = (Get-Item -LiteralPath $installer).Length; sha256 = (Get-FileHash -LiteralPath $installer).Hash; integrity = ($integrity | ConvertFrom-Json) }
  })
  $niriaReport.installers = $installers
  $niriaReport.sentinel = $niriaSentinel
  if ($InspectOnly) {
    $plan = [ordered]@{
      inspectOnly = $true; systemChanges = $false; installers = $installers
      plannedInstallDirectory = $niriaInstall; plannedDataDirectory = $niriaData
      plannedShortcuts = $niriaLinks; defaultDataDirectory = $niriaDefaultData
      defaultDataWrite = 'Unique temporary sentinel file only; no existing files are replaced'
      preflight = @{ existingInstallation = $false; existingShortcut = $false; runningNiria = $false; defaultCompanionDatabase = $false; fixtureAvailable = $true }
      steps = @('install-0.14.0', 'verify-old-native-data', "upgrade-$niriaVersion", 'compare-installed-runtime',
        'verify-migration-and-restart', 'installed-desktop-regression', 'uninstall-and-check-retention',
        "reinstall-$niriaVersion", 'verify-restart', 'uninstall-and-clean-test-shortcuts')
      executionRequiresExplicitApproval = $true
    }
    $planFile = Join-Path $niriaArtifacts ('installer-plan-' + [Guid]::NewGuid().ToString('N') + '.json')
    $plan | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $planFile -Encoding utf8
    [ordered]@{ inspectOnly = $true; systemChanges = $false; planFile = $planFile; plan = $plan } | ConvertTo-Json -Depth 100
    return
  }
  New-Item -ItemType Directory -Path $niriaData -Force | Out-Null
  New-Item -ItemType Directory -Path $niriaDefaultData -Force | Out-Null
  [IO.File]::WriteAllText($niriaSentinel, $niriaSentinelText)
  $niriaSentinelCreated = $true
  foreach ($name in @('companion.sqlite', 'upgrade-expected.json', 'legacy-backup.niria')) {
    Copy-Item -LiteralPath (Join-Path $fixture.dataDirectory $name) -Destination (Join-Path $niriaData $name)
  }
  & node --input-type=module -e 'import{readFileSync,writeFileSync}from"node:fs";const f=JSON.parse(readFileSync(process.argv[1],"utf8"));writeFileSync(process.argv[2],JSON.stringify({state:f.expected,meta:f.syncMeta}));' (Join-Path $niriaData 'upgrade-expected.json') (Join-Path $niriaData 'upgraded-state.json')
  Assert-Check ($LASTEXITCODE -eq 0) 'Failed to prepare legacy restart expectation'
  $niriaMayOwnInstall = $true
  Install-Niria $niriaOldVersion
  Run-NativePhase 'storage-restart'
  $legacyHash = (Get-FileHash -LiteralPath (Join-Path $niriaData 'companion.sqlite')).Hash
  Install-Niria $niriaVersion
  Assert-Check ((Get-FileHash -LiteralPath (Join-Path $niriaData 'companion.sqlite')).Hash -eq $legacyHash) 'Installer modified companion data before app migration'
  & node (Join-Path $niriaWorkspace 'scripts\verify-package.mjs') --directory $niriaInstall
  Assert-Check ($LASTEXITCODE -eq 0) 'Installed archive differs from source'
  Add-Phase 'installed-package-equality' @{ source = $true; version = $niriaVersion }
  Run-NativePhase 'storage-upgrade'
  Run-NativePhase 'storage-restart'
  if (-not $SkipFullRegression) {
    & node (Join-Path $niriaWorkspace 'scripts\desktop-smoke.mjs') --executable (Join-Path $niriaInstall 'NIRIA.exe') --upgrade --upgrade-v2 > (Join-Path $niriaRun 'installed-regression.log') 2>&1
    Assert-Check ($LASTEXITCODE -eq 0) 'Installed desktop regression failed; see installed-regression.log'
    Add-Phase 'installed-full-regression' @{ passed = $true }
  }
  Uninstall-Niria
  Install-Niria $niriaVersion
  Run-NativePhase 'storage-restart'
  Uninstall-Niria
  $niriaMayOwnInstall = $false
  $niriaReport.ok = $true
} catch {
  $niriaReport.error = $_.Exception.Message
  throw
} finally {
  if ($niriaMayOwnInstall) {
    $records = @(Get-NiriaRegistration)
    if ($records.Count -eq 1 -and $records[0].UninstallString.StartsWith('"' + (Join-Path $niriaInstall 'Uninstall NIRIA.exe') + '"', [StringComparison]::OrdinalIgnoreCase)) {
      try { Uninstall-Niria } catch { Write-Warning "Isolated test installation requires cleanup: $niriaInstall" }
    }
  }
  if ($niriaSentinelCreated -and (Test-Path -LiteralPath $niriaSentinel) -and [IO.File]::ReadAllText($niriaSentinel) -eq $niriaSentinelText) {
    Remove-Item -LiteralPath $niriaSentinel
  }
  if (Test-Path -LiteralPath $niriaRun) {
    $niriaReport.cleanup = [ordered]@{
      installationRemoved = -not (Test-Path -LiteralPath $niriaInstall)
      registrationRemoved = @(Get-NiriaRegistration).Count -eq 0
      shortcutsRemoved = @($niriaLinks | Where-Object { Test-Path -LiteralPath $_ }).Count -eq 0
      sentinelRemoved = -not (Test-Path -LiteralPath $niriaSentinel)
      applicationExited = @(Get-Process -Name NIRIA -ErrorAction SilentlyContinue).Count -eq 0
    }
    if ($niriaReport.ok -and @($niriaReport.cleanup.Values | Where-Object { $_ -ne $true }).Count -gt 0) {
      $niriaReport.ok = $false
      $niriaReport.error = 'Test system state was not fully cleaned up'
    }
    $niriaReport | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $niriaRun 'result.json') -Encoding utf8
  }
}
Assert-Check $niriaReport.ok $niriaReport.error
$niriaReport | ConvertTo-Json -Depth 100
