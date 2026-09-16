param(
    [Parameter(Mandatory)][ValidateSet('Enroll', 'Read', 'Remove')][string]$Action,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9-]{0,63}$')][string]$Alias
)
$ErrorActionPreference = 'Stop'
$vault = Join-Path $env:LOCALAPPDATA 'SessionBrowser/vault'
$credentialPath = Join-Path $vault "$Alias.credential.xml"
try {
    if (-not $IsWindows) { throw 'Windows required' }
    switch ($Action) {
        'Enroll' {
            $credential = Get-Credential -Message "Session Browser: $Alias (stored with Windows DPAPI)"
            if ($null -eq $credential) { throw 'Enrollment canceled' }
            New-Item -ItemType Directory -Path $vault -Force | Out-Null
            $credential | Export-Clixml -LiteralPath $credentialPath
            Write-Output 'Credential enrolled locally.'
        }
        'Read' {
            $credential = Import-Clixml -LiteralPath $credentialPath
            if ($credential -isnot [System.Management.Automation.PSCredential]) { throw 'Invalid credential' }
            @{
                username = $credential.UserName
                password = $credential.GetNetworkCredential().Password
            } | ConvertTo-Json -Compress
        }
        'Remove' {
            Remove-Item -LiteralPath $credentialPath
            Write-Output 'Credential removed.'
        }
    }
} catch {
    [Console]::Error.WriteLine('Credential operation failed. Enroll or unlock it locally; do not send secrets to chat.')
    exit 1
}