const { CommandOutputAnalyzer } = require('../../dist/command-output/analyzer.js');
const { invokeProcess, invokeShellProcess } = require('../../dist/capture/process.js');

async function runCommand(request) {
  const command = String(request.Command || '');
  const argumentList = Array.isArray(request.ArgumentList) ? request.ArgumentList.map(String) : [];
  const shell = request.Shell;
  const processResult = shell
    ? invokeShellProcess(command, shell)
    : invokeProcess(command, argumentList);
  return new CommandOutputAnalyzer().analyze({
    outputKind: 'command',
    exitCode: processResult.ExitCode,
    combinedText: processResult.Combined,
    commandText: shell ? `[${shell}] ${command}` : [command, ...argumentList].join(' '),
    question: request.Question,
    riskLevel: request.RiskLevel,
    reducerProfile: request.ReducerProfile,
    format: request.Format,
    policyProfile: request.PolicyProfile,
    backend: request.Backend,
    model: request.Model,
    noSummarize: request.NoSummarize,
    shell,
  });
}

module.exports = { runCommand };
