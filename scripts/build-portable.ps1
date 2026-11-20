[CmdletBinding()]
param(
    [string] $ElectronZip,
    [string] $NodeZip
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem

$repo = Split-Path -Parent $PSScriptRoot
$buildRoot = [IO.Directory]::CreateDirectory((Join-Path $repo 'build')).FullName
$cache = [IO.Directory]::CreateDirectory((Join-Path $buildRoot 'portable-cache')).FullName
$stage = Join-Path $buildRoot ('portable-' + [guid]::NewGuid().ToString('N'))
$electronRelease = 'v43.3.0'
$nodeRelease = 'v24.15.0'
$electronArchive = "electron-$electronRelease-win32-x64.zip"
$nodeFolder = "node-$nodeRelease-win-x64"

function Assert-ArchiveHash([string] $Path, [string] $Expected) {
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Expected) {
        throw "SHA-256 mismatch for $Path. Supply an unmodified runtime ZIP."
    }
}

function Publish-File([string] $Source, [string] $Destination) {
    try {
        [IO.File]::Move($Source, $Destination)
    } catch [IO.IOException] {
        if (-not [IO.File]::Exists($Destination)) { throw }
        [IO.File]::Replace($Source, $Destination, [NullString]::Value)
    }
}

function Get-RuntimeZip([string] $InputPath, [string] $Name, [string] $Uri, [string] $Sha256) {
    if ($InputPath) {
        $file = (Resolve-Path -LiteralPath $InputPath).ProviderPath
        Assert-ArchiveHash $file $Sha256
        return $file
    }

    $file = Join-Path $cache $Name
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        Assert-ArchiveHash $file $Sha256
        return $file
    }

    $download = "$file.$([guid]::NewGuid().ToString('N')).partial"
    try {
        Write-Host "Downloading $Name"
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $download -TimeoutSec 240
        Assert-ArchiveHash $download $Sha256
        Publish-File $download $file
        return $file
    } finally {
        if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download }
    }
}

function Copy-PackageFile([string] $Source, [string] $Target) {
    [void] [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Target))
    [IO.File]::Copy($Source, $Target)
}

function Write-PortableZip([string] $Directory, [string] $Destination) {
    [string[]] $files = [IO.Directory]::GetFiles($Directory, '*', 'AllDirectories')
    [Array]::Sort($files, [StringComparer]::Ordinal)
    $zip = [IO.Compression.ZipFile]::Open($Destination, 'Create', [Text.Encoding]::UTF8)
    try {
        $timestamp = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        foreach ($file in $files) {
            $relativePath = $file.Substring($Directory.Length + 1).Replace('\', '/')
            $entry = $zip.CreateEntry($relativePath, 'Optimal')
            $entry.LastWriteTime = $timestamp
            $inputStream = [IO.File]::OpenRead($file)
            try {
                $entryStream = $entry.Open()
                try { $inputStream.CopyTo($entryStream) } finally { $entryStream.Dispose() }
            } finally {
                $inputStream.Dispose()
            }
        }
    } finally {
        $zip.Dispose()
    }
}

# Pinned official asset digests (Electron GitHub release, Node SHASUMS256.txt).
$electron = Get-RuntimeZip $ElectronZip $electronArchive `
    "https://github.com/electron/electron/releases/download/$electronRelease/$electronArchive" `
    '18528bedc6a9b04bdc5efb7b803cbc3cb0e5ea6415d54046e23d464d89a00da9'
$nodeArchive = Get-RuntimeZip $NodeZip "$nodeFolder.zip" `
    "https://nodejs.org/dist/$nodeRelease/$nodeFolder.zip" `
    'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62'

try {
    $package = Join-Path $stage 'package'
    $app = Join-Path $package 'app'
    [void] [IO.Directory]::CreateDirectory($app)
    [IO.Compression.ZipFile]::ExtractToDirectory($electron, $app)
    Rename-Item -LiteralPath (Join-Path $app 'electron.exe') -NewName 'dsh-pet.exe'
    Remove-Item -LiteralPath (Join-Path $app 'resources/default_app.asar')

    [IO.Compression.ZipFile]::ExtractToDirectory($nodeArchive, $stage)
    $node = Join-Path $stage "$nodeFolder/node.exe"
    $npm = Join-Path $stage "$nodeFolder/node_modules/npm/bin/npm-cli.js"
    Copy-PackageFile $node (Join-Path $package 'bridge/runtime/node.exe')
    Copy-PackageFile (Join-Path $stage "$nodeFolder/LICENSE") (Join-Path $package 'bridge/runtime/LICENSE')

    # Git defines which application files ship. Copy their current working-tree bytes.
    $encoding = [Console]::OutputEncoding
    $git = (Get-Command git.exe -CommandType Application | Select-Object -First 1).Source
    try {
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $tracked = & $git -C $repo ls-files -z -- 'pet-app/'
        if ($LASTEXITCODE -ne 0) { throw 'Could not list tracked app files.' }
    } finally {
        [Console]::OutputEncoding = $encoding
    }
    $files = $tracked -split '\x00' | Where-Object { $_ }
    foreach ($file in $files) {
        $source = Get-Item -LiteralPath (Join-Path $repo $file)
        if ($source.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Tracked app input cannot be a link: $file"
        }
        Copy-PackageFile $source.FullName (Join-Path $stage $file)
    }

    Copy-PackageFile (Join-Path $repo 'asar-tools/package.json') (Join-Path $stage 'asar-tools/package.json')
    Copy-PackageFile (Join-Path $repo 'asar-tools/package-lock.json') (Join-Path $stage 'asar-tools/package-lock.json')
    Push-Location -LiteralPath $stage
    try {
        & $node $npm ci --prefix asar-tools --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Could not install the locked ASAR build tools.' }
        & $node asar-tools/node_modules/@electron/asar/bin/asar.mjs pack pet-app package/app/resources/app.asar
        if ($LASTEXITCODE -ne 0) { throw 'Could not pack the pet application.' }
    } finally {
        Pop-Location
    }

    foreach ($name in @('watch.mjs', 'lifecycle.mjs', 'probe.ps1')) {
        Copy-PackageFile (Join-Path $repo "codex-bridge/$name") (Join-Path $package "bridge/$name")
    }
    Copy-PackageFile (Join-Path $repo 'codex-bridge/conversation.json') (Join-Path $package 'data/conversation.json')
    Copy-PackageFile (Join-Path $repo 'codex-bridge/main-config.jsonc') (Join-Path $package 'data/dsh-pet/main-config.jsonc')
    foreach ($name in @('启动桌宠.vbs', '停止桌宠.vbs', '使用说明.txt')) {
        Copy-PackageFile (Join-Path $PSScriptRoot "portable/$name") (Join-Path $package $name)
    }
    foreach ($name in @('LICENSE', 'THIRD_PARTY_NOTICES.md')) {
        Copy-PackageFile (Join-Path $repo $name) (Join-Path $package $name)
    }

    $pendingZip = Join-Path $stage 'codex-pet-win-x64.zip'
    Write-PortableZip $package $pendingZip
    $dist = [IO.Directory]::CreateDirectory((Join-Path $repo 'dist')).FullName
    $output = Join-Path $dist 'codex-pet-win-x64.zip'
    Publish-File $pendingZip $output
    Get-FileHash -LiteralPath $output -Algorithm SHA256
} finally {
    if (Test-Path -LiteralPath $stage -PathType Container) {
        $stagePath = (Resolve-Path -LiteralPath $stage).ProviderPath
        if ((Split-Path -Parent $stagePath) -ne $buildRoot -or
            (Split-Path -Leaf $stagePath) -notmatch '^portable-[a-f0-9]{32}$') {
            throw "Unexpected staging path: $stagePath"
        }
        Remove-Item -LiteralPath $stagePath -Recurse -Force
    }
}
