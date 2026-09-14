$ErrorActionPreference = 'Stop'

# URL-install MSIs aren't cached locally: uninstall via the registered
# product code (stable per Tauri bundle identifier com.tokenhorizon.app).
Get-ChildItem "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" |
  ForEach-Object { Get-ItemProperty $_.PSPath } |
  Where-Object { $_.DisplayName -like 'Token Horizon*' } |
  ForEach-Object {
    Uninstall-ChocolateyPackage -packageName 'token-horizon' -fileType 'msi' `
      -silentArgs "$($_.PSChildName) /qn /norestart" `
      -validExitCodes @(0, 3010, 1605, 1614, 1641)
  }
