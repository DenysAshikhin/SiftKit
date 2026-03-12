$script:SiftKitVersion = '0.1.0'

function Get-SiftKitRoot {
    $modulePath = $MyInvocation.MyCommand.Module.Path
    Split-Path -Path $modulePath -Parent
}

function Get-SiftRepoPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    Join-Path -Path (Split-Path -Path (Get-SiftKitRoot) -Parent) -ChildPath $RelativePath
}

function Get-SiftTsRuntimePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    $candidatePaths = @(
        (Get-SiftRepoPath -RelativePath (Join-Path -Path 'dist' -ChildPath $RelativePath)),
        (Join-Path -Path (Get-SiftKitRoot) -ChildPath (Join-Path -Path 'dist' -ChildPath $RelativePath))
    )

    foreach ($runtimePath in $candidatePaths) {
        if (Test-Path -LiteralPath $runtimePath) {
            return $runtimePath
        }
    }

    throw ('TS runtime entrypoint not found. Checked: {0}. Run npm run build.' -f ($candidatePaths -join '; '))
}

function New-SiftDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        $null = New-Item -Path $Path -ItemType Directory -Force
    }

    [System.IO.Path]::GetFullPath($Path)
}

function Save-SiftUtf8NoBomFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    $directory = Split-Path -Path $Path -Parent
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
        $null = New-SiftDirectory -Path $directory
    }

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function New-SiftTempTextFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Content,
        [string]$Prefix = 'siftkit'
    )

    $path = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ('{0}_{1}_{2}.txt' -f $Prefix, $PID, [System.Guid]::NewGuid().ToString('N'))
    Save-SiftUtf8NoBomFile -Path $path -Content $Content
    $path
}

function Format-SiftArgument {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Argument
    )

    if ($Argument -notmatch '[\s"]') {
        return $Argument
    }

    '"' + ($Argument -replace '"', '\"') + '"'
}

function Invoke-SiftCapturedProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string[]]$ArgumentList = @()
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Command
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = (Get-Location).Path

    if ($ArgumentList.Count -gt 0) {
        $psi.Arguments = (($ArgumentList | ForEach-Object { Format-SiftArgument -Argument $_ }) -join ' ')
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi

    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    [pscustomobject]@{
        ExitCode = $process.ExitCode
        StdOut = $stdout
        StdErr = $stderr
    }
}

function Invoke-SiftTsInternal {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Operation,
        [Parameter(Mandatory = $true)]
        [object]$RequestObject,
        [ValidateSet('json', 'text')]
        [string]$ResponseFormat = 'json'
    )

    $cliPath = Get-SiftTsRuntimePath -RelativePath 'src\cli.js'
    $requestPath = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ('siftkit_request_{0}_{1}.json' -f $PID, [System.Guid]::NewGuid().ToString('N'))
    try {
        Save-SiftUtf8NoBomFile -Path $requestPath -Content ($RequestObject | ConvertTo-Json -Depth 12 -Compress)
        $processResult = Invoke-SiftCapturedProcess -Command 'node' -ArgumentList @(
            $cliPath,
            'internal',
            '--op',
            $Operation,
            '--request-file',
            $requestPath,
            '--response-format',
            $ResponseFormat
        )
        if ($processResult.ExitCode -ne 0) {
            $message = if (-not [string]::IsNullOrWhiteSpace($processResult.StdErr)) {
                $processResult.StdErr.Trim()
            }
            elseif (-not [string]::IsNullOrWhiteSpace($processResult.StdOut)) {
                $processResult.StdOut.Trim()
            }
            else {
                'Unknown TS runtime failure.'
            }

            throw $message
        }

        if ($ResponseFormat -eq 'text') {
            return $processResult.StdOut
        }

        if ([string]::IsNullOrWhiteSpace($processResult.StdOut)) {
            return $null
        }

        $processResult.StdOut | ConvertFrom-Json
    }
    finally {
        if (Test-Path -LiteralPath $requestPath) {
            Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Normalize-SiftInputText {
    param(
        [AllowNull()]
        [string]$Text
    )

    if ($null -eq $Text) {
        return $null
    }

    $Text.TrimEnd([char[]]@("`r", "`n"))
}

function Get-SiftPropertyValue {
    param(
        [Parameter(Mandatory = $true)]
        [object]$InputObject,
        [Parameter(Mandatory = $true)]
        [string]$PropertyName
    )

    $property = $InputObject.PSObject.Properties[$PropertyName]
    if ($property) {
        return $property.Value
    }

    $null
}

function Test-SiftFormatData {
    param(
        [Parameter(Mandatory = $true)]
        [object]$InputObject
    )

    $typeName = $InputObject.GetType().FullName
    $typeName -like 'Microsoft.PowerShell.Commands.Internal.Format.*'
}

function Convert-SiftListFormatDataToText {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Items
    )

    $entryItems = @($Items | Where-Object { $_.GetType().Name -eq 'FormatEntryData' })
    if ($entryItems.Count -eq 0) {
        return $null
    }

    $allLines = New-Object System.Collections.Generic.List[string]
    for ($entryIndex = 0; $entryIndex -lt $entryItems.Count; $entryIndex++) {
        $entry = Get-SiftPropertyValue -InputObject $entryItems[$entryIndex] -PropertyName 'formatEntryInfo'
        $fields = @(Get-SiftPropertyValue -InputObject $entry -PropertyName 'listViewFieldList')
        if ($fields.Count -eq 0) {
            continue
        }

        $names = @()
        foreach ($field in $fields) {
            $label = [string](Get-SiftPropertyValue -InputObject $field -PropertyName 'label')
            if ([string]::IsNullOrWhiteSpace($label)) {
                $label = [string](Get-SiftPropertyValue -InputObject $field -PropertyName 'propertyName')
            }

            $names += $label
        }

        $nameWidth = @($names | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum
        for ($fieldIndex = 0; $fieldIndex -lt $fields.Count; $fieldIndex++) {
            $formatField = Get-SiftPropertyValue -InputObject $fields[$fieldIndex] -PropertyName 'formatPropertyField'
            $value = [string](Get-SiftPropertyValue -InputObject $formatField -PropertyName 'propertyValue')
            [void]$allLines.Add(('{0} : {1}' -f $names[$fieldIndex].PadRight($nameWidth), $value))
        }

        if ($entryIndex -lt ($entryItems.Count - 1)) {
            [void]$allLines.Add('')
        }
    }

    Normalize-SiftInputText -Text ($allLines -join [Environment]::NewLine)
}

function Convert-SiftTableFormatDataToText {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Items,
        [Parameter(Mandatory = $true)]
        [object]$ShapeInfo
    )

    $columns = @(Get-SiftPropertyValue -InputObject $ShapeInfo -PropertyName 'tableColumnInfoList')
    if ($columns.Count -eq 0) {
        return $null
    }

    $headers = @()
    foreach ($column in $columns) {
        $label = [string](Get-SiftPropertyValue -InputObject $column -PropertyName 'label')
        if ([string]::IsNullOrWhiteSpace($label)) {
            $label = [string](Get-SiftPropertyValue -InputObject $column -PropertyName 'propertyName')
        }

        $headers += $label
    }

    $rows = @()
    foreach ($entryItem in @($Items | Where-Object { $_.GetType().Name -eq 'FormatEntryData' })) {
        $entry = Get-SiftPropertyValue -InputObject $entryItem -PropertyName 'formatEntryInfo'
        $fields = @(Get-SiftPropertyValue -InputObject $entry -PropertyName 'formatPropertyFieldList')
        $row = @()
        foreach ($field in $fields) {
            $row += [string](Get-SiftPropertyValue -InputObject $field -PropertyName 'propertyValue')
        }

        $rows += ,$row
    }

    $widths = @()
    for ($columnIndex = 0; $columnIndex -lt $headers.Count; $columnIndex++) {
        $width = $headers[$columnIndex].Length
        foreach ($row in $rows) {
            if ($columnIndex -lt $row.Count -and $row[$columnIndex].Length -gt $width) {
                $width = $row[$columnIndex].Length
            }
        }

        $widths += $width
    }

    $separator = '  '
    $lines = New-Object System.Collections.Generic.List[string]
    [void]$lines.Add((0..($headers.Count - 1) | ForEach-Object { $headers[$_].PadRight($widths[$_]) }) -join $separator)
    [void]$lines.Add((0..($headers.Count - 1) | ForEach-Object { ('-' * $widths[$_]) }) -join $separator)
    foreach ($row in $rows) {
        [void]$lines.Add((0..($headers.Count - 1) | ForEach-Object {
            $value = if ($_ -lt $row.Count) { $row[$_] } else { '' }
            $value.PadRight($widths[$_])
        }) -join $separator)
    }

    Normalize-SiftInputText -Text ($lines -join [Environment]::NewLine)
}

function Convert-SiftFormatDataToText {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Items
    )

    if ($Items.Count -eq 0 -or ($Items | Where-Object { -not (Test-SiftFormatData -InputObject $_) }).Count -gt 0) {
        return $null
    }

    $startData = $Items | Where-Object { $_.GetType().Name -eq 'FormatStartData' } | Select-Object -First 1
    if (-not $startData) {
        return $null
    }

    $shapeInfo = Get-SiftPropertyValue -InputObject $startData -PropertyName 'shapeInfo'
    if (-not $shapeInfo) {
        return $null
    }

    switch ($shapeInfo.GetType().Name) {
        'ListViewHeaderInfo' { return (Convert-SiftListFormatDataToText -Items $Items) }
        'TableHeaderInfo' { return (Convert-SiftTableFormatDataToText -Items $Items -ShapeInfo $shapeInfo) }
        default { return $null }
    }
}

function Convert-SiftPipelineItemToText {
    param(
        [AllowNull()]
        [object]$Item
    )

    if ($null -eq $Item) {
        return $null
    }

    if ($Item -is [System.Management.Automation.ErrorRecord]) {
        $message = $Item.Exception.Message
        if (-not [string]::IsNullOrWhiteSpace($message)) {
            return $message.TrimEnd([char[]]@("`r", "`n"))
        }
    }

    if ($Item -is [string]) {
        return $Item
    }

    return [string]$Item
}

function Convert-SiftPipelineBufferToText {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IEnumerable]$PipelineBuffer
    )

    $items = @($PipelineBuffer)
    if ($items.Count -eq 0) {
        return ''
    }

    $allRenderableAsText = $true
    foreach ($item in $items) {
        if ($item -isnot [string] -and $item -isnot [System.Management.Automation.ErrorRecord]) {
            $allRenderableAsText = $false
            break
        }
    }

    if ($allRenderableAsText) {
        $lines = @($items | ForEach-Object { Convert-SiftPipelineItemToText -Item $_ } | Where-Object { $null -ne $_ })
        return (Normalize-SiftInputText -Text ($lines -join [Environment]::NewLine))
    }

    try {
        $rendered = Normalize-SiftInputText -Text ($items | Out-String -Width 200)
        if (-not [string]::IsNullOrWhiteSpace($rendered)) {
            return $rendered
        }
    }
    catch [System.InvalidOperationException] {
    }

    $formattedText = Convert-SiftFormatDataToText -Items $items
    if ($null -ne $formattedText) {
        return $formattedText
    }

    Normalize-SiftInputText -Text (($items | ForEach-Object { Convert-SiftPipelineItemToText -Item $_ }) -join [Environment]::NewLine)
}

function Get-SiftInputText {
    param(
        [string]$Text,
        [string]$InputFile,
        [System.Collections.IEnumerable]$PipelineBuffer
    )

    if ($PSBoundParameters.ContainsKey('Text')) {
        return (Normalize-SiftInputText -Text $Text)
    }

    if ($PSBoundParameters.ContainsKey('InputFile')) {
        if (-not (Test-Path -LiteralPath $InputFile)) {
            throw "Input file not found: $InputFile"
        }

        return (Normalize-SiftInputText -Text (Get-Content -LiteralPath $InputFile -Raw))
    }

    if ($PipelineBuffer -and $PipelineBuffer.Count -gt 0) {
        return (Convert-SiftPipelineBufferToText -PipelineBuffer $PipelineBuffer)
    }

    throw 'No input text was provided.'
}

function Resolve-SiftExternalCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandName
    )

    $commands = @(Get-Command -Name $CommandName -All -ErrorAction SilentlyContinue)
    foreach ($command in $commands) {
        if ($command.CommandType -in @('Application', 'ExternalScript')) {
            return $command.Source
        }
    }

    $fallback = Get-Command -Name ("{0}.exe" -f $CommandName) -ErrorAction SilentlyContinue
    if ($fallback) {
        return $fallback.Source
    }

    throw "Unable to resolve external command: $CommandName"
}

function Test-SiftInteractiveGitArguments {
    param(
        [string[]]$ArgumentList = @()
    )

    if ($ArgumentList.Count -eq 0) {
        return $false
    }

    $subcommand = $ArgumentList[0].ToLowerInvariant()
    $joined = ($ArgumentList -join ' ').ToLowerInvariant()

    if ($subcommand -eq 'rebase' -and $joined -match '(^|\s)(-i|--interactive)(\s|$)') {
        return $true
    }

    if ($subcommand -in @('add', 'checkout', 'restore') -and $joined -match '(^|\s)-p(\s|$)') {
        return $true
    }

    $subcommand -in @('mergetool', 'commit')
}

function Test-SiftInteractiveCommandMatch {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandName,
        [string[]]$ArgumentList = @(),
        [AllowNull()]
        [object]$Config
    )

    if ($Config -and $Config.PSObject.Properties['Interactive'] -and -not [bool]$Config.Interactive.Enabled) {
        return $false
    }

    $normalizedCommand = $CommandName.ToLowerInvariant()
    $configured = @()
    if ($Config -and $Config.PSObject.Properties['Interactive'] -and $Config.Interactive.PSObject.Properties['WrappedCommands']) {
        $configured = @($Config.Interactive.WrappedCommands | ForEach-Object { [string]$_ })
    }

    if ($normalizedCommand -eq 'git') {
        return (Test-SiftInteractiveGitArguments -ArgumentList $ArgumentList)
    }

    $configured -contains $normalizedCommand
}

function Test-SiftPipelineTargetsSiftKit {
    param(
        [AllowNull()]
        [string]$InvocationLine
    )

    if ([string]::IsNullOrWhiteSpace($InvocationLine)) {
        return $false
    }

    $InvocationLine -match '\|\s*(?:&\s*)?(?:"[^"]*[\\/])?siftkit(?:\.cmd|\.ps1|\.js)?\b'
}

function Get-SiftQuestionFromInvocationLine {
    param(
        [AllowNull()]
        [string]$InvocationLine
    )

    if ([string]::IsNullOrWhiteSpace($InvocationLine)) {
        return 'Summarize the important result and any actionable failures.'
    }

    $patterns = @(
        '\|\s*(?:&\s*)?(?:"[^"]*[\\/])?siftkit(?:\.cmd|\.ps1|\.js)?\s+"([^"]+)"',
        "\|\s*(?:&\s*)?(?:""[^""]*[\\/])?siftkit(?:\.cmd|\.ps1|\.js)?\s+'([^']+)'",
        '\|\s*(?:&\s*)?(?:"[^"]*[\\/])?siftkit(?:\.cmd|\.ps1|\.js)?\s+summary\s+--question\s+"([^"]+)"',
        "\|\s*(?:&\s*)?(?:""[^""]*[\\/])?siftkit(?:\.cmd|\.ps1|\.js)?\s+summary\s+--question\s+'([^']+)'"
    )

    foreach ($pattern in $patterns) {
        if ($InvocationLine -match $pattern) {
            return $Matches[1]
        }
    }

    'Summarize the important result and any actionable failures.'
}

function Enable-SiftInteractiveShellIntegration {
    [CmdletBinding()]
    param()

    $commands = @('git', 'less', 'vim', 'sqlite3')
    foreach ($commandName in $commands) {
        $scriptBlock = [scriptblock]::Create(@"
param([Parameter(ValueFromRemainingArguments = `$true)][string[]]`$Arguments)
Invoke-SiftInteractiveCommandWrapper -CommandName '$commandName' -ArgumentList `$Arguments -InvocationLine `$MyInvocation.Line
"@)
        Set-Item -Path ("Function:global:{0}" -f $commandName) -Value $scriptBlock
    }
}

function Invoke-SiftInteractiveCapture {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string[]]$ArgumentList = @(),
        [string]$Question = 'Summarize the important result and any actionable failures.',
        [ValidateSet('text', 'json')]
        [string]$Format = 'text',
        [string]$Backend,
        [string]$Model,
        [ValidateSet('general', 'pass-fail', 'unique-errors', 'buried-critical', 'json-extraction', 'diff-summary', 'risky-operation')]
        [string]$PolicyProfile = 'general'
    )

    Invoke-SiftTsInternal -Operation 'interactive-capture' -RequestObject @{
        Command = $Command
        ArgumentList = @($ArgumentList)
        Question = $Question
        Format = $Format
        Backend = $Backend
        Model = $Model
        PolicyProfile = $PolicyProfile
    }
}

function Invoke-SiftInteractiveCommandWrapper {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandName,
        [string[]]$ArgumentList = @(),
        [AllowNull()]
        [string]$InvocationLine
    )

    $config = Get-SiftKitConfig
    if ((Test-SiftPipelineTargetsSiftKit -InvocationLine $InvocationLine) -and (Test-SiftInteractiveCommandMatch -CommandName $CommandName -ArgumentList $ArgumentList -Config $config)) {
        $question = Get-SiftQuestionFromInvocationLine -InvocationLine $InvocationLine
        $captureResult = Invoke-SiftInteractiveCapture -Command $CommandName -ArgumentList $ArgumentList -Question $question
        $captureResult.OutputText
        return
    }

    $resolvedCommand = Resolve-SiftExternalCommand -CommandName $CommandName
    & $resolvedCommand @ArgumentList
}

function Install-SiftKit {
    [CmdletBinding()]
    param(
        [switch]$Force
    )

    Invoke-SiftTsInternal -Operation 'install' -RequestObject @{
        Force = [bool]$Force
    }
}

function Test-SiftKit {
    [CmdletBinding()]
    param()

    $result = Invoke-SiftTsInternal -Operation 'test' -RequestObject @{}
    if (-not $result.PSObject.Properties['PowerShellVersion']) {
        $result | Add-Member -NotePropertyName PowerShellVersion -NotePropertyValue $PSVersionTable.PSVersion.ToString()
    }
    $result
}

function Get-SiftKitConfig {
    [CmdletBinding()]
    param()

    Invoke-SiftTsInternal -Operation 'config-get' -RequestObject @{}
}

function Set-SiftKitConfig {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Key,
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Value
    )

    Invoke-SiftTsInternal -Operation 'config-set' -RequestObject @{
        Key = $Key
        Value = $Value
    }
}

function Invoke-SiftSummary {
    [CmdletBinding(DefaultParameterSetName = 'Pipeline')]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$Question,
        [Parameter(ParameterSetName = 'Text', Mandatory = $true)]
        [string]$Text,
        [Parameter(ParameterSetName = 'File', Mandatory = $true)]
        [string]$InputFile,
        [Parameter(ParameterSetName = 'Pipeline', ValueFromPipeline = $true)]
        [object]$InputObject,
        [ValidateSet('text', 'json')]
        [string]$Format = 'text',
        [string]$Backend,
        [string]$Model,
        [ValidateSet('general', 'pass-fail', 'unique-errors', 'buried-critical', 'json-extraction', 'diff-summary', 'risky-operation')]
        [string]$PolicyProfile = 'general'
    )

    begin {
        $buffer = New-Object System.Collections.Generic.List[object]
    }

    process {
        if ($null -eq $InputObject) {
            return
        }

        if ($InputObject -is [string] -and $InputObject.Length -eq 0) {
            return
        }

        [void]$buffer.Add($InputObject)
    }

    end {
        $inputArgs = @{
            PipelineBuffer = $buffer
        }
        if ($PSBoundParameters.ContainsKey('Text')) {
            $inputArgs.Text = $Text
        }
        if ($PSBoundParameters.ContainsKey('InputFile')) {
            $inputArgs.InputFile = $InputFile
        }

        $inputText = Get-SiftInputText @inputArgs
        $textFile = New-SiftTempTextFile -Content $inputText -Prefix 'siftkit_summary'
        try {
            Invoke-SiftTsInternal -Operation 'summary' -RequestObject @{
                Question = $Question
                TextFile = $textFile
                Format = $Format
                Backend = $Backend
                Model = $Model
                PolicyProfile = $PolicyProfile
            }
        }
        finally {
            if (Test-Path -LiteralPath $textFile) {
                Remove-Item -LiteralPath $textFile -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

function Invoke-SiftCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string[]]$ArgumentList = @(),
        [string]$Question = 'Summarize the main result and any actionable failures.',
        [ValidateSet('informational', 'debug', 'risky')]
        [string]$RiskLevel = 'informational',
        [ValidateSet('smart', 'errors', 'tail', 'diff', 'none')]
        [string]$ReducerProfile = 'smart',
        [ValidateSet('text', 'json')]
        [string]$Format = 'text',
        [ValidateSet('general', 'pass-fail', 'unique-errors', 'buried-critical', 'json-extraction', 'diff-summary', 'risky-operation')]
        [string]$PolicyProfile = 'general',
        [string]$Backend,
        [string]$Model,
        [switch]$NoSummarize
    )

    Invoke-SiftTsInternal -Operation 'command' -RequestObject @{
        Command = $Command
        ArgumentList = @($ArgumentList)
        Question = $Question
        RiskLevel = $RiskLevel
        ReducerProfile = $ReducerProfile
        Format = $Format
        PolicyProfile = $PolicyProfile
        Backend = $Backend
        Model = $Model
        NoSummarize = [bool]$NoSummarize
    }
}

function Invoke-SiftEvaluation {
    [CmdletBinding()]
    param(
        [string]$FixtureRoot = (Get-SiftRepoPath -RelativePath 'eval\fixtures'),
        [string[]]$RealLogPath = @(),
        [string]$Backend,
        [string]$Model
    )

    Invoke-SiftTsInternal -Operation 'eval' -RequestObject @{
        FixtureRoot = $FixtureRoot
        RealLogPath = @($RealLogPath)
        Backend = $Backend
        Model = $Model
    }
}

function Find-SiftFiles {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string[]]$Name,
        [string]$Path = '.',
        [switch]$FullPath
    )

    Invoke-SiftTsInternal -Operation 'find-files' -RequestObject @{
        Name = @($Name)
        Path = $Path
        FullPath = [bool]$FullPath
    }
}

function Install-SiftCodexPolicy {
    [CmdletBinding()]
    param(
        [string]$CodexHome = (Join-Path -Path $env:USERPROFILE -ChildPath '.codex'),
        [switch]$Force
    )

    Invoke-SiftTsInternal -Operation 'codex-policy' -RequestObject @{
        CodexHome = $CodexHome
        Force = [bool]$Force
    }
}

function Install-SiftKitShellIntegration {
    [CmdletBinding()]
    param(
        [string]$BinDir = (Join-Path -Path $env:USERPROFILE -ChildPath 'bin'),
        [string]$ModuleInstallRoot = (Join-Path -Path ([Environment]::GetFolderPath('MyDocuments')) -ChildPath 'WindowsPowerShell\Modules'),
        [switch]$Force
    )

    Invoke-SiftTsInternal -Operation 'install-global' -RequestObject @{
        BinDir = $BinDir
        ModuleRoot = $ModuleInstallRoot
        Force = [bool]$Force
    }
}

Export-ModuleMember -Function Install-SiftKit, Test-SiftKit, Get-SiftKitConfig, Set-SiftKitConfig, Invoke-SiftSummary, Invoke-SiftCommand, Invoke-SiftEvaluation, Find-SiftFiles, Install-SiftCodexPolicy, Install-SiftKitShellIntegration, Enable-SiftInteractiveShellIntegration, Invoke-SiftInteractiveCapture, Invoke-SiftInteractiveCommandWrapper
