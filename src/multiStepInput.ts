import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { parseSshConfig, SshHostEntry } from './sshConfigParser';
import { generateAll } from './configGenerator';
import { detectCondaEnvs, CondaEnv, CondaProbeError } from './remoteCondaProbe';

interface HostQuickPickItem extends vscode.QuickPickItem {
    entry: SshHostEntry;
}

interface CondaEnvQuickPickItem extends vscode.QuickPickItem {
    env?: CondaEnv;
    manualEntry?: boolean;
}

const MANUAL_ENTRY_LABEL = '$(edit) Type env name manually...';
const DEFAULT_DEBUG_PORT = 5678;
const DEFAULT_CONDA_ROOT = '~/miniconda3';

interface CondaSelection {
    condaEnv: string;
    condaRoot: string;
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

async function manualCondaFallback(): Promise<CondaSelection | undefined> {
    const condaEnv = await promptCondaEnvManually();
    if (!condaEnv) {
        return undefined;
    }
    const condaRoot = await promptCondaRootManually();
    if (!condaRoot) {
        return undefined;
    }
    return { condaEnv, condaRoot };
}

async function pickCondaSelection(hostAlias: string): Promise<CondaSelection | undefined> {
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
        title: 'Remote Config Generator (4/4)',
        placeHolder: `Select remote conda environment (conda root: ${result.condaRoot})`,
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
    return { condaEnv: picked.env.name, condaRoot: result.condaRoot };
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

    // Step 4: Conda env + conda root (auto-detect from remote, with manual fallback)
    const condaSelection = await pickCondaSelection(picked.entry.host);
    if (!condaSelection) {
        return;
    }

    // Generate all config files
    generateAll({
        host: picked.entry,
        sshConfigPath,
        remoteProjectRoot: remoteRoot,
        condaEnv: condaSelection.condaEnv,
        condaRoot: condaSelection.condaRoot,
        workspaceRoot,
        debugPort: DEFAULT_DEBUG_PORT,
    });

    vscode.window.showInformationMessage(
        `Generated remote configs for ${picked.label} in workspace.`
    );
}
