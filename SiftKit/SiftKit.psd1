@{
    RootModule = 'SiftKit.psm1'
    ModuleVersion = '0.1.0'
    GUID = 'f7a87db8-9237-4ad4-a676-b5c171840701'
    Author = 'OpenAI Codex'
    CompanyName = 'OpenAI'
    Copyright = '(c) OpenAI'
    Description = 'Windows-first shell-output compression toolkit for Codex workflows.'
    PowerShellVersion = '5.1'
    FunctionsToExport = @(
        'Install-SiftKit',
        'Test-SiftKit',
        'Get-SiftKitConfig',
        'Set-SiftKitConfig',
        'Invoke-SiftSummary',
        'Invoke-SiftCommand',
        'Invoke-SiftEvaluation',
        'Find-SiftFiles',
        'Install-SiftCodexPolicy',
        'Install-SiftKitShellIntegration',
        'Install-SiftKitService',
        'Uninstall-SiftKitService',
        'Enable-SiftInteractiveShellIntegration',
        'Invoke-SiftInteractiveCapture',
        'Invoke-SiftInteractiveCommandWrapper'
    )
    CmdletsToExport = @()
    VariablesToExport = @()
    AliasesToExport = @()
    PrivateData = @{
        PSData = @{
            Tags = @('codex', 'ollama', 'powershell', 'summarization')
            ProjectUri = 'https://github.com/denys/SiftKit'
        }
    }
}
