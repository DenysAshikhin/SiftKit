export type InstallSiftKitResult = {
    Installed: true;
    ConfigPath: string;
    RuntimeRoot: string;
    LogsPath: string;
    EvalResultsPath: string;
    Backend: string;
    Model: string | null;
    LlamaCppBaseUrl: string | null;
    LlamaCppReachable: boolean;
    AvailableModels: string[];
};
export declare function installSiftKit(force?: boolean): Promise<InstallSiftKitResult>;
export type InstallCodexPolicyResult = {
    AgentsPath: string;
    Installed: true;
};
export declare function installCodexPolicy(codexHome?: string, force?: boolean): Promise<InstallCodexPolicyResult>;
export type InstallShellIntegrationResult = {
    Installed: true;
    ModulePath: string;
    BinDir: string;
    PowerShellShim: string;
    CmdShim: string;
    ShellIntegrationScript: string;
    PathHint: string;
    ProfileHint: string;
};
export declare function installShellIntegration(options?: {
    BinDir?: string;
    ModuleInstallRoot?: string;
    Force?: boolean;
}): Promise<InstallShellIntegrationResult>;
