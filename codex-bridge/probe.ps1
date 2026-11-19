$ErrorActionPreference = 'Stop'
while ($true) {
    try {
        $matches = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" | ForEach-Object {
            [pscustomobject]@{
                pid = [int]$_.ProcessId
                path = [string]$_.ExecutablePath
                commandLine = [string]$_.CommandLine
                created = [string]$_.CreationDate.ToUniversalTime().ToString('o')
            }
        })
        @{ ok = $true; processes = $matches } | ConvertTo-Json -Depth 4 -Compress
    } catch {
        '{"ok":false,"processes":[]}'
    }
    Start-Sleep -Seconds 2
}
