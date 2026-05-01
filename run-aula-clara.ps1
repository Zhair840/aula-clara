$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

function Find-Node {
  $candidates = @()

  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    $candidates += $cmd.Source
  }

  $candidates += Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\node.exe"
  $candidates += "C:\Program Files\nodejs\node.exe"

  $windowsAppsNodes = Get-ChildItem "C:\Program Files\WindowsApps" -Filter node.exe -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like "*OpenAI.Codex*resources*node.exe" } |
    Select-Object -ExpandProperty FullName

  $candidates += $windowsAppsNodes

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  return $null
}

$node = Find-Node

if (-not $node) {
  Write-Host "No encontre Node.js en esta maquina." -ForegroundColor Red
  Write-Host "Instala Node.js desde https://nodejs.org y vuelve a ejecutar este script."
  exit 1
}

if (-not $env:OPENAI_API_KEY) {
  Write-Host "Pega tu OPENAI_API_KEY nueva. No se va a mostrar mientras escribes." -ForegroundColor Yellow
  $secureKey = Read-Host "OPENAI_API_KEY" -AsSecureString
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  )
  $env:OPENAI_API_KEY = $plainKey
}

Write-Host ""
Write-Host "Usando Node: $node" -ForegroundColor DarkGray
Write-Host "Aula Clara se abrira en http://localhost:3000" -ForegroundColor Green
Write-Host "Deja esta ventana abierta mientras uses la app." -ForegroundColor Green
Write-Host ""

& $node server.js
