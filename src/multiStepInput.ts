import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { parseSshConfig, SshHostEntry } from './sshConfigParser';
import { generateAll } from './configGenerator';
import { detectCondaEnvs, CondaEnv, CondaProbeError } from './remoteCondaProbe';
import { setupLocalIntelliSense } from './localEnvSetup';

interface HostQuickPickItem extends vscode.QuickPickItem {
    entry: SshHostEntry;
}

interface CondaEnvQuickPickItem extends vscode.QuickPickItem {
    env?: CondaEnv;
    manualEntry?: boolean;
}

interface EnvTypeQuickPickItem extends vscode.QuickPickItem {
    envType: 'conda' | 'venv' | 'system';
}

const MANUAL_ENTRY_LABEL = '$(edit) Type env name manually...';
const DEFAULT_DEBUG_PORT = 5678;
const DEFAULT_CONDA_ROOT = '~/miniconda3';

interface EnvSelection {
    envType: 'conda' | 'venv' | 'system';
    condaEnv?: string;
    condaRoot?: string;
    venvPath?: string;
}

async function promptCondaRootManually(): Promise<string | undefined> {
    return vscode.window.showInputBox({
        title: 'Remote Conda Root',
        prompt: 'Path to conda installation on remote (parent of etc/profile.d/conda.sh)',
        value: DEFAULT_CONDA_ROOT,
        validateInput: (v) => v.trim() ? null : 'Cannot be empty',
    });
}

async function promptCondaEnvManually(): Promise<string | undefined> {
    return vscode.window.showInputBox({
        title: 'Remote Conda Env Name',
        prompt: 'Conda environment name on remote',
        placeHolder: 'base',
        validateInput: (v) => v.trim() ? null : 'Cannot be empty',
    });
}

async function manualCondaFallback(): Promise<EnvSelection | undefined> {
    const condaEnv = await promptCondaEnvManually();
    if (!condaEnv) {
        return undefined;
    }
    const condaRoot = await promptCondaRootManually();
    if (!condaRoot) {
        return undefined;
    }
    return { envType: 'conda', condaEnv, condaRoot };
}

async function pickCondaSelection(hostAlias: string): Promise<EnvSelection | undefined> {
    let result: { envs: CondaEnv[]; condaRoot: string } | undefined;
    try {
        result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Detecting remote conda envs on ${hostAlias}...`,
                cancellable: false,
            },
            () => detectCondaEnvs(hostAlias)
        );
    } catch (e) {
        const reason =
            e instanceof CondaProbeError
                ? (e.cause ? `${e.message} (${e.cause})` : e.message)
                : (e as Error).message;
        vscode.window.showWarningMessage(
            `Could not detect conda envs on ${hostAlias}: ${reason} Falling back to manual entry.`
        );
        return manualCondaFallback();
    }

    const items: CondaEnvQuickPickItem[] = result.envs.map((e) => ({
        label: e.name,
        description: e.path,
        env: e,
    }));
    items.push({ label: MANUAL_ENTRY_LABEL, manualEntry: true });

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Select conda environment',
        placeHolder: `conda root: ${result.condaRoot}`,
    });
    if (!picked) {
        return undefined;
    }
    if (picked.manualEntry) {
        return manualCondaFallback();
    }
    if (!picked.env) {
        return undefined;
    }
    return { envType: 'conda', condaEnv: picked.env.name, condaRoot: result.condaRoot };
}

async function pickVenvPath(): Promise<EnvSelection | undefined> {
    const venvPath = await vscode.window.showInputBox({
        title: 'Remote virtualenv path',
        prompt: 'Absolute path to virtual environment on remote (e.g., /home/user/project/.venv)',
        placeHolder: '/home/user/project/.venv',
        validateInput: (v) => v.startsWith('/') ? null : 'Must be an absolute path',
    });
    if (!venvPath) {
        return undefined;
    }
    return { envType: 'venv', venvPath };
}

async function pickEnvSelection(hostAlias: string): Promise<EnvSelection | undefined> {
    const envTypes: EnvTypeQuickPickItem[] = [
        {
            label: '$(package) Conda',
            description: 'Auto-detect conda environments on the remote',
            envType: 'conda',
        },
        {
            label: '$(folder) Virtualenv / venv',
            description: 'Specify a virtual environment path on the remote',
            envType: 'venv',
        },
        {
            label: '$(symbol-misc) System Python',
            description: 'Use system Python directly (no environment manager)',
            envType: 'system',
        },
    ];

    const picked = await vscode.window.showQuickPick(envTypes, {
        title: 'Remote Config Generator — Python environment type',
        placeHolder: 'How is Python managed on your remote machine?',
    });
    if (!picked) {
        return undefined;
    }

    switch (picked.envType) {
        case 'conda':
            return pickCondaSelection(hostAlias);
        case 'venv':
            return pickVenvPath();
        case 'system':
            return { envType: 'system' };
    }
}

export async function runGenerateFlow(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
    }

    // Step 1: SSH config path
    const defaultConfigPath = path.join(os.homedir(), '.ssh', 'config');
    const sshConfigPath = await vscode.window.showInputBox({
        title: 'Remote Config Generator (1/4)',
        prompt: 'Path to SSH config file',
        value: defaultConfigPath,
        validateInput: (v) => fs.existsSync(v) ? null : 'File not found',
    });
    if (!sshConfigPath) {
        return;
    }

    // Step 2: Parse and pick host
    let entries: SshHostEntry[];
    try {
        entries = parseSshConfig(sshConfigPath);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to parse SSH config: ${e.message}`);
        return;
    }

    if (entries.length === 0) {
        vscode.window.showErrorMessage('No hosts found in SSH config.');
        return;
    }

    const items: HostQuickPickItem[] = entries.map((e) => ({
        label: e.host,
        description: `${e.hostName}:${e.port} - ${e.user}`,
        entry: e,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Remote Config Generator (2/4)',
        placeHolder: 'Select SSH host',
    });
    if (!picked) {
        return;
    }

    // Step 3: Remote project root
    const remoteRoot = await vscode.window.showInputBox({
        title: 'Remote Config Generator (3/4)',
        prompt: 'Project root path on remote host',
        placeHolder: '/home/user/project',
        validateInput: (v) => v.startsWith('/') ? null : 'Must be an absolute path',
    });
    if (!remoteRoot) {
        return;
    }

    // Step 4: Python environment type + env details
    const envSelection = await pickEnvSelection(picked.entry.host);
    if (!envSelection) {
        return;
    }

    const opts = {
        host: picked.entry,
        sshConfigPath,
        remoteProjectRoot: remoteRoot,
        envType: envSelection.envType,
        condaEnv: envSelection.condaEnv ?? '',
        condaRoot: envSelection.condaRoot ?? '',
        venvPath: envSelection.venvPath ?? '',
        workspaceRoot,
        debugPort: DEFAULT_DEBUG_PORT,
    };
    generateAll(opts);

    vscode.window.showInformationMessage(
        `Generated remote configs for ${picked.label} in workspace.`
    );

    // Optional: set up local IntelliSense environment
    const setupChoice = await vscode.window.showInformationMessage(
        'Set up local IntelliSense? Mirrors remote packages locally so Pylance provides syntax checking and autocomplete.',
        'Yes (Recommended)',
        'Skip'
    );
    if (setupChoice === 'Yes (Recommended)') {
        const cfg = {
            host: picked.entry.host,
            remoteProjectRoot: remoteRoot,
            envType: envSelection.envType,
            condaRoot: envSelection.condaRoot,
            condaEnv: envSelection.condaEnv,
            venvPath: envSelection.venvPath,
            debugPort: DEFAULT_DEBUG_PORT,
        };
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Setting up IntelliSense' },
            (progress) => setupLocalIntelliSense(cfg as any, workspaceRoot, progress)
        );
    }
}
