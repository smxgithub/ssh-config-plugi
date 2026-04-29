import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, execFile, ChildProcess } from 'child_process';
import { escapeBashSingleQuoted } from './shellEscape';

const LAUNCH_CONFIG_NAME = 'Run on Remote (Python)';

export interface RemoteConfig {
    host: string;
    remoteProjectRoot: string;
    condaRoot: string;
    condaEnv: string;
    debugPort: number;
}

interface ActiveSession {
    child: ChildProcess;
    output: vscode.OutputChannel;
}

let active: ActiveSession | undefined;

export function loadConfig(wsPath: string): RemoteConfig | undefined {
    const p = path.join(wsPath, '.vscode', 'remote-config-gen.json');
    if (!fs.existsSync(p)) {
        vscode.window.showErrorMessage(
            'No .vscode/remote-config-gen.json found. Run "Generate Remote Dev Configs" first.'
        );
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) {
        vscode.window.showErrorMessage(`Failed to parse remote-config-gen.json: ${(e as Error).message}`);
        return undefined;
    }
}

function execFileAsync(
    cmd: string,
    args: string[],
    opts?: { timeout?: number; cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: opts?.timeout ?? 30_000, cwd: opts?.cwd, windowsHide: true },
            (err, stdout, stderr) => {
                if (err) {
                    reject(Object.assign(err, { stderr }));
                } else {
                    resolve({ stdout, stderr });
                }
            }
        );
    });
}

function runSync(
    cfg: RemoteConfig,
    wsPath: string,
    relativeFile: string,
    output: vscode.OutputChannel
): Promise<void> {
    return (async () => {
        const remoteRelative = relativeFile.replace(/\\/g, '/');
        const remoteFile = `${cfg.remoteProjectRoot.replace(/\/+$/, '')}/${remoteRelative}`;
        const remoteDir = remoteFile.substring(0, remoteFile.lastIndexOf('/'));
        const localAbsPath = path.resolve(wsPath, relativeFile);

        if (!fs.existsSync(localAbsPath)) {
            throw new Error(`Local file not found: ${localAbsPath}`);
        }

        const escapedDir = escapeBashSingleQuoted(remoteDir);
        try {
            await execFileAsync('ssh', [cfg.host, `mkdir -p '${escapedDir}'`]);
        } catch (e: any) {
            throw new Error(`Failed to create remote directory: ${e.stderr || e.message}`);
        }

        try {
            await execFileAsync('scp', ['--', localAbsPath, `${cfg.host}:${remoteFile}`]);
        } catch (e: any) {
            throw new Error(`Failed to upload file: ${e.stderr || e.message}`);
        }

        output.appendLine(`[sync] Synced ${relativeFile} -> ${remoteFile}`);
    })();
}

function buildRemoteDebugCommand(cfg: RemoteConfig, remoteRelative: string): string {
    const root = escapeBashSingleQuoted(cfg.remoteProjectRoot);
    const condaRoot = escapeBashSingleQuoted(cfg.condaRoot);
    const condaEnv = escapeBashSingleQuoted(cfg.condaEnv);
    const remoteFile = escapeBashSingleQuoted(
        `${cfg.remoteProjectRoot.replace(/\/+$/, '')}/${remoteRelative.replace(/\\/g, '/')}`
    );

    const ensureDebugpy =
        `(python -c 'import debugpy' 2>/dev/null || ` +
        `(echo 'installing debugpy on first run...' && pip install debugpy))`;
    const cleanup =
        `(lsof -ti tcp:${cfg.debugPort} 2>/dev/null | xargs -r kill 2>/dev/null; sleep 0.3)`;
    const debugpyCmd =
        `PYTHONUNBUFFERED=1 python -u -m debugpy ` +
        `--log-to-stderr ` +
        `--listen 0.0.0.0:${cfg.debugPort} --wait-for-client '${remoteFile}'`;
    return (
        `cd '${root}' && ` +
        `source '${condaRoot}/etc/profile.d/conda.sh' && ` +
        `conda activate '${condaEnv}' && ` +
        `${ensureDebugpy} && ${cleanup} && ${debugpyCmd}`
    );
}

function buildRemoteRunCommand(cfg: RemoteConfig, remoteRelative: string): string {
    const root = escapeBashSingleQuoted(cfg.remoteProjectRoot);
    const condaRoot = escapeBashSingleQuoted(cfg.condaRoot);
    const condaEnv = escapeBashSingleQuoted(cfg.condaEnv);
    const remoteFile = escapeBashSingleQuoted(
        `${cfg.remoteProjectRoot.replace(/\/+$/, '')}/${remoteRelative.replace(/\\/g, '/')}`
    );
    return (
        `cd '${root}' && ` +
        `source '${condaRoot}/etc/profile.d/conda.sh' && ` +
        `conda activate '${condaEnv}' && ` +
        `PYTHONUNBUFFERED=1 python -u '${remoteFile}'`
    );
}

function validateActiveEditor(folder: vscode.WorkspaceFolder): {
    wsPath: string; relativeFile: string; fileFsPath: string;
} | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
        vscode.window.showErrorMessage('Open and focus a Python file in the editor first.');
        return undefined;
    }
    const fileFsPath = editor.document.uri.fsPath;
    if (path.extname(fileFsPath).toLowerCase() !== '.py') {
        vscode.window.showErrorMessage(
            `Active file must be a Python (.py) file. Got: ${path.basename(fileFsPath)}.`
        );
        return undefined;
    }
    const wsPath = folder.uri.fsPath;
    const relativeFile = path.relative(wsPath, fileFsPath);
    if (relativeFile.startsWith('..') || path.isAbsolute(relativeFile)) {
        vscode.window.showErrorMessage(
            `Active file ${fileFsPath} is outside the workspace folder ${wsPath}.`
        );
        return undefined;
    }
    return { wsPath, relativeFile, fileFsPath };
}

export async function runRemoteDebug(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
    }
    const ctx = validateActiveEditor(folder);
    if (!ctx) {
        return;
    }
    const { wsPath, relativeFile } = ctx;

    const cfg = loadConfig(wsPath);
    if (!cfg) {
        return;
    }

    if (active) {
        const stop = await vscode.window.showWarningMessage(
            'A remote debug session is already running. Stop it and start a new one?',
            { modal: false },
            'Stop and restart'
        );
        if (stop !== 'Stop and restart') {
            return;
        }
        try { active.child.kill(); } catch { /* ignore */ }
        active = undefined;
    }

    const output = vscode.window.createOutputChannel('Remote Debug');
    output.show(true);
    output.appendLine(`[plugin] starting remote debug for ${relativeFile} on port ${cfg.debugPort}`);

    try {
        output.appendLine(`[plugin] syncing ${relativeFile} to ${cfg.host}...`);
        await runSync(cfg, wsPath, relativeFile, output);
        output.appendLine(`[plugin] sync ok`);
    } catch (e) {
        const msg = (e as Error).message;
        output.appendLine(`[plugin] sync failed: ${msg}`);
        vscode.window.showErrorMessage(`Sync failed: ${msg}`);
        return;
    }

    const remoteCmd = buildRemoteDebugCommand(cfg, relativeFile);
    output.appendLine(
        `[plugin] spawning: ssh -L ${cfg.debugPort}:localhost:${cfg.debugPort} ${cfg.host} <remote command>`
    );

    const child = spawn(
        'ssh',
        [
            '-o', 'ConnectTimeout=10',
            '-o', 'ServerAliveInterval=30',
            '-L', `${cfg.debugPort}:localhost:${cfg.debugPort}`,
            cfg.host,
            remoteCmd,
        ],
        { cwd: wsPath, windowsHide: true }
    );

    active = { child, output };

    let attached = false;
    const listeningRegex = new RegExp(
        `(adapter is accepting incoming client|debugpy.*listening|listening on)`,
        'i'
    );
    let buffer = '';

    const handleChunk = async (chunk: Buffer | string, label: string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        for (const line of text.split(/\r?\n/)) {
            if (line.length > 0) {
                output.appendLine(`[${label}] ${line}`);
            }
        }
        if (attached) {
            return;
        }
        buffer += text;
        if (listeningRegex.test(buffer)) {
            attached = true;
            output.appendLine(`[plugin] detected debugpy listening; attaching debugger...`);
            try {
                const ok = await vscode.debug.startDebugging(folder, LAUNCH_CONFIG_NAME);
                if (!ok) {
                    output.appendLine('[plugin] vscode.debug.startDebugging returned false.');
                    vscode.window.showErrorMessage('Failed to start debug session.');
                    try { child.kill(); } catch { /* ignore */ }
                }
            } catch (e) {
                output.appendLine(`[plugin] attach error: ${(e as Error).message}`);
                try { child.kill(); } catch { /* ignore */ }
            }
        }
    };

    child.stdout?.on('data', (c) => void handleChunk(c, 'ssh-out'));
    child.stderr?.on('data', (c) => void handleChunk(c, 'ssh-err'));

    child.on('close', (code, signal) => {
        output.appendLine(`[plugin] ssh exited (code=${code} signal=${signal})`);
        if (active && active.child === child) {
            active = undefined;
        }
        if (!attached) {
            vscode.window.showErrorMessage(
                `Remote debugger never reported listening on port ${cfg.debugPort}. ` +
                `See "Remote Debug" output channel.`
            );
        }
    });

    child.on('error', (err) => {
        output.appendLine(`[plugin] ssh process error: ${err.message}`);
    });

    const sub = vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.name === LAUNCH_CONFIG_NAME) {
            output.appendLine('[plugin] debug session terminated; killing ssh');
            try { child.kill(); } catch { /* ignore */ }
            sub.dispose();
        }
    });
}

export function disposeActive(): void {
    if (active) {
        try { active.child.kill(); } catch { /* ignore */ }
        active = undefined;
    }
}

export async function runRemoteRun(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
    }
    const ctx = validateActiveEditor(folder);
    if (!ctx) {
        return;
    }
    const { wsPath, relativeFile, fileFsPath } = ctx;

    const cfg = loadConfig(wsPath);
    if (!cfg) {
        return;
    }

    const syncLog = vscode.window.createOutputChannel('Remote Run');
    syncLog.appendLine(`[plugin] running ${relativeFile} on ${cfg.host}`);
    try {
        syncLog.appendLine(`[plugin] syncing...`);
        await runSync(cfg, wsPath, relativeFile, syncLog);
        syncLog.appendLine(`[plugin] sync ok`);
    } catch (e) {
        const msg = (e as Error).message;
        syncLog.appendLine(`[plugin] sync failed: ${msg}`);
        syncLog.show(true);
        vscode.window.showErrorMessage(`Sync failed: ${msg}`);
        return;
    }

    const remoteCmd = buildRemoteRunCommand(cfg, relativeFile);
    const terminal = vscode.window.createTerminal({
        name: `Run on Remote: ${path.basename(fileFsPath)}`,
        shellPath: 'ssh',
        shellArgs: [cfg.host, remoteCmd],
    });
    terminal.show(true);
}
