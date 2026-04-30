import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { escapeBashSingleQuoted } from './shellEscape';
import { RemoteConfig } from './remoteDebugCommand';

function execAsync(
    cmd: string,
    args: string[],
    opts?: { timeout?: number; cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, {
            timeout: opts?.timeout ?? 120_000,
            cwd: opts?.cwd,
            windowsHide: true,
            maxBuffer: 10 * 1024 * 1024,
        }, (err, stdout, stderr) => {
            if (err) {
                reject(Object.assign(err, { stderr }));
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

function envKey(cfg: RemoteConfig): string {
    switch (cfg.envType) {
        case 'conda':
            return `${cfg.host}-${cfg.condaEnv || 'base'}`;
        case 'venv':
            return `${cfg.host}-venv-${path.basename(cfg.venvPath || '.venv')}`;
        case 'system':
            return `${cfg.host}-system`;
    }
}

function sharedEnvDir(): string {
    return path.join(os.homedir(), '.remote-config-gen', 'envs');
}

function envPath(cfg: RemoteConfig): string {
    return path.join(sharedEnvDir(), envKey(cfg));
}

function localPythonBin(venvDir: string): string {
    return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
}

async function findLocalPython(): Promise<string | undefined> {
    for (const bin of ['python3', 'python']) {
        try {
            const { stdout } = await execAsync(bin, ['--version'], { timeout: 10_000 });
            if (stdout.includes('Python 3') || stdout.includes('python 3')) {
                return bin;
            }
        } catch {
            // try next
        }
    }
    return undefined;
}

function buildRemotePipFreezeCommand(cfg: RemoteConfig): string {
    const root = escapeBashSingleQuoted(cfg.remoteProjectRoot);
    switch (cfg.envType) {
        case 'conda': {
            const condaRoot = escapeBashSingleQuoted(cfg.condaRoot ?? '~/miniconda3');
            const condaEnv = escapeBashSingleQuoted(cfg.condaEnv ?? 'base');
            return `source '${condaRoot}/etc/profile.d/conda.sh' && conda activate '${condaEnv}' && pip freeze`;
        }
        case 'venv': {
            const venvPath = escapeBashSingleQuoted(cfg.venvPath ?? '.venv');
            return `cd '${root}' && source '${venvPath}/bin/activate' && pip freeze`;
        }
        case 'system':
            return `pip freeze 2>/dev/null || pip3 freeze`;
    }
}

export async function setupLocalIntelliSense(
    cfg: RemoteConfig,
    wsPath: string,
    progress: vscode.Progress<{ message?: string }>
): Promise<boolean> {
    const venvDir = envPath(cfg);
    const pythonBin = localPythonBin(venvDir);

    // If shared env already exists, just point settings.json to it.
    if (fs.existsSync(pythonBin)) {
        progress.report({ message: 'Reusing existing local IntelliSense env...' });
        await writeInterpreterSetting(wsPath, pythonBin);
        return true;
    }

    // Check local Python
    progress.report({ message: 'Checking local Python...' });
    const localPython = await findLocalPython();
    if (!localPython) {
        vscode.window.showWarningMessage(
            'No local Python 3 found. Install Python locally for IntelliSense support. ' +
            'Your remote run/debug still works without it.'
        );
        return false;
    }

    // Get remote packages
    progress.report({ message: 'Fetching remote package list...' });
    const freezeCmd = buildRemotePipFreezeCommand(cfg);
    let requirements: string;
    try {
        const { stdout } = await execAsync('ssh', [cfg.host, freezeCmd], { timeout: 30_000 });
        requirements = stdout.trim();
    } catch (e: any) {
        vscode.window.showWarningMessage(
            `Could not fetch remote packages: ${e.stderr || e.message}. IntelliSense setup skipped.`
        );
        return false;
    }

    if (!requirements) {
        progress.report({ message: 'No packages found on remote.' });
        await createVenv(localPython, venvDir);
        await writeInterpreterSetting(wsPath, pythonBin);
        return true;
    }

    // Create local venv
    progress.report({ message: 'Creating local IntelliSense environment...' });
    await createVenv(localPython, venvDir);

    // Write requirements to temp file
    const reqFile = path.join(venvDir, 'requirements-remote.txt');
    fs.writeFileSync(reqFile, requirements, 'utf-8');

    // Install packages (best-effort, skip failures)
    progress.report({ message: 'Installing packages locally (for IntelliSense)...' });
    try {
        await execAsync(
            pythonBin,
            ['-m', 'pip', 'install', '--no-deps', '--quiet', '-r', reqFile],
            { timeout: 300_000, cwd: venvDir }
        );
    } catch {
        // Some packages fail (Linux-only, etc.) — that's expected. Pylance still
        // benefits from whatever DID install.
    }

    // Point workspace to the shared env
    await writeInterpreterSetting(wsPath, pythonBin);

    const lines = requirements.split(/\r?\n/).filter((l) => l.trim().length > 0);
    vscode.window.showInformationMessage(
        `Local IntelliSense env ready (${lines.length} packages). Pylance should now provide syntax checking.`
    );
    return true;
}

async function createVenv(pythonBin: string, venvDir: string): Promise<void> {
    fs.mkdirSync(path.dirname(venvDir), { recursive: true });
    if (fs.existsSync(venvDir)) {
        return;
    }
    await execAsync(pythonBin, ['-m', 'venv', venvDir], { timeout: 60_000 });
}

async function writeInterpreterSetting(wsPath: string, pythonPath: string): Promise<void> {
    const settingsDir = path.join(wsPath, '.vscode');
    fs.mkdirSync(settingsDir, { recursive: true });
    const settingsPath = path.join(settingsDir, 'settings.json');

    let settings: Record<string, any> = {};
    if (fs.existsSync(settingsPath)) {
        try {
            const { parse } = require('jsonc-parser');
            settings = parse(fs.readFileSync(settingsPath, 'utf-8')) ?? {};
        } catch {
            settings = {};
        }
    }

    settings['python.defaultInterpreterPath'] = pythonPath;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n', 'utf-8');
}

export async function refreshLocalIntelliSense(wsPath: string): Promise<void> {
    const cfgPath = path.join(wsPath, '.vscode', 'remote-config-gen.json');
    if (!fs.existsSync(cfgPath)) {
        vscode.window.showErrorMessage('No remote config found. Run "Generate Remote Dev Configs" first.');
        return;
    }
    const cfg: RemoteConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const venvDir = envPath(cfg);

    // Delete existing env to force re-creation
    if (fs.existsSync(venvDir)) {
        fs.rmSync(venvDir, { recursive: true, force: true });
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Refreshing IntelliSense Packages' },
        (progress) => setupLocalIntelliSense(cfg, wsPath, progress)
    );
}
