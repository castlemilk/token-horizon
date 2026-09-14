$ErrorActionPreference = 'Stop'
$packageName = 'token-horizon'
# Substituted by CI (release-desktop.yml) from the tagged .msi + checksum.
$url64      = '__URL__'
$checksum64 = '__SHA256__'

$packageArgs = @{
  packageName    = $packageName
  fileType       = 'msi'
  url64bit       = $url64
  checksum64     = $checksum64
  checksumType64 = 'sha256'
  silentArgs     = '/qn /norestart'
  validExitCodes = @(0, 3010, 1641)
}

Install-ChocolateyPackage @packageArgs
