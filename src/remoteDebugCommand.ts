import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { spawn, execFile, ChildProcess } from 'child_process';
import { escapeBashSingleQuoted } from './shellEscape';

export interface RemoteConfig {
    host: string;
    remoteProjectRoot: string;
    envType: 'conda' | 'venv' | 'system';
    condaRoot?: string;
    condaEnv?: string;
    venvPath?: string;
    debugPort: number;
}

interface ActiveSession {
    child: ChildProcess;
    output: vscode.OutputChannel;
}

let active: ActiveSession | undefined;

function getSettings() {
    const cfg = vscode.workspace.getConfiguration('remoteConfigGen');
    return {
        debugPort: cfg.get<number>('debugPort', 5678),
        pythonBinary: cfg.get<string>('pythonBinary', 'python'),
        syncExcludes: cfg.get<string[]>('syncExcludes', [
            '__pycache__', '.git', '*.pyc', 'node_modules', '.venv', '.mypy_cache',
        ]),
    };
}

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

function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as net.AddressInfo).port;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

function buildEnvActivation(cfg: RemoteConfig, pythonBinary: string): string {
    switch (cfg.envType) {
        case 'conda': {
            const condaRoot = escapeBashSingleQuoted(cfg.condaRoot ?? '~/miniconda3');
            const condaEnv = escapeBashSingleQuoted(cfg.condaEnv ?? 'base');
            return `source '${condaRoot}/etc/profile.d/conda.sh' && conda activate '${condaEnv}'`;
        }
        case 'venv': {
            const venvPath = escapeBashSingleQuoted(cfg.venvPath ?? '.venv');
            return `source '${venvPath}/bin/activate'`;
        }
        case 'system':
            return `true`;
    }
}

// --- Project sync using tar | ssh ---

export function syncProject(
    cfg: RemoteConfig,
    wsPath: string,
    output: vscode.OutputChannel,
    excludes: string[]
): Promise<void> {
    return new Promise((resolve, reject) => {
        const remoteRoot = escapeBashSingleQuoted(cfg.remoteProjectRoot);
        const excludeArgs = excludes.flatMap((e) => ['--exclude', e]);

        const tarArgs = ['czf', '-', ...excludeArgs, '-C', wsPath, '.'];
        const sshArgs = [cfg.host, `mkdir -p '${remoteRoot}' && cd '${remoteRoot}' && tar xzf -`];

        const tar = spawn('tar', tarArgs, { windowsHide: true });
        const ssh = spawn('ssh', sshArgs, { windowsHide: true });

        tar.stdout.pipe(ssh.stdin);

        const errors: string[] = [];
        tar.stderr?.on('data', (c) => errors.push(`[tar] ${c}`));
        ssh.stderr?.on('data', (c) => errors.push(`[ssh] ${c}`));

        let tarDone = false;
        let sshDone = false;
        let tarCode = 0;
        let sshCode = 0;

        const checkDone = () => {
            if (!tarDone || !sshDone) {
                return;
            }
            if (tarCode !== 0 || sshCode !== 0) {
                const msg = errors.join('').trim() || `tar exit=${tarCode} ssh exit=${sshCode}`;
                output.appendLine(`[sync] failed: ${msg}`);
                reject(new Error(`Sync failed: ${msg}`));
            } else {
                output.appendLine(`[sync] project synced to ${cfg.host}:${cfg.remoteProjectRoot}`);
                resolve();
            }
        };

        tar.on('close', (code) => { tarCode = code ?? 0; tarDone = true; checkDone(); });
        ssh.on('close', (code) => { sshCode = code ?? 0; sshDone = true; checkDone(); });
        tar.on('error', (err) => { errors.push(`[tar] ${err.message}`); tarCode = 1; tarDone = true; checkDone(); });
        ssh.on('error', (err) => { errors.push(`[ssh] ${err.message}`); sshCode = 1; sshDone = true; checkDone(); });
    });
}

// --- Single-file sync (used by file watcher) ---

export function syncFile(
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
            return;
        }

        const escapedDir = escapeBashSingleQuoted(remoteDir);
        try {
            await execFileAsync('ssh', [cfg.host, `mkdir -p '${escapedDir}'`]);
        } catch (e: any) {
            throw new Error(`mkdir failed: ${e.stderr || e.message}`);
        }

        try {
            await execFileAsync('scp', ['--', localAbsPath, `${cfg.host}:${remoteFile}`]);
        } catch (e: any) {
            throw new Error(`scp failed: ${e.stderr || e.message}`);
        }

        output.appendLine(`[sync] ${relativeFile} -> ${remoteFile}`);
    })();
}

// --- Error parsing ---

function parseErrorMessage(stderr: string, cfg: RemoteConfig): string | undefined {
    if (/connection refused/i.test(stderr)) {
        return `Cannot connect to ${cfg.host}. Check if the host is running and SSH key is set up.`;
    }
    if (/permission denied/i.test(stderr)) {
        return `SSH authentication failed for ${cfg.host}. Check your SSH key or password.`;
    }
    if (/conda activate.*not found|EnvironmentNameNotFound/i.test(stderr)) {
        return `Conda environment not found on remote. Re-run "Generate Remote Dev Configs" to pick a different env.`;
    }
    if (/No module named/i.test(stderr)) {
        const match = stderr.match(/No module named '?(\w+)'?/);
        return `Missing Python module "${match?.[1] ?? '?'}" on remote. Install it: ssh ${cfg.host} "pip install ${match?.[1] ?? '...'}"`;
    }
    if (/address already in use/i.test(stderr)) {
        return `Port ${cfg.debugPort} is busy on remote. The plugin auto-cleans stale processes; try again.`;
    }
    if (/no such file or directory/i.test(stderr) && /\.venv|bin\/activate/.test(stderr)) {
        return `Virtual environment not found on remote. Check the venv path in your config.`;
    }
    return undefined;
}

// --- Build remote commands ---

function buildRemoteDebugCommand(cfg: RemoteConfig, remoteRelative: string, port: number): string {
    const settings = getSettings();
    const root = escapeBashSingleQuoted(cfg.remoteProjectRoot);
    const py = settings.pythonBinary;
    const activation = buildEnvActivation(cfg, py);
    const remoteFile = escapeBashSingleQuoted(
        `${cfg.remoteProjectRoot.replace(/\/+$/, '')}/${remoteRelative.replace(/\\/g, '/')}`
    );

    const ensureDebugpy =
        `(${py} -c 'import debugpy' 2>/dev/null || ` +
        `(echo 'installing debugpy on first run...' && pip install debugpy))`;
    const cleanup =
        `(lsof -ti tcp:${port} 2>/dev/null | xargs -r kill 2>/dev/null; sleep 0.3)`;
    const debugpyCmd =
        `PYTHONUNBUFFERED=1 ${py} -u -m debugpy ` +
        `--log-to-stderr ` +
        `--listen 0.0.0.0:${port} --wait-for-client '${remoteFile}'`;
    return (
        `cd '${root}' && ${activation} && ` +
        `${ensureDebugpy} && ${cleanup} && ${debugpyCmd}`
    );
}

function buildRemoteRunCommand(cfg: RemoteConfig, remoteRelative: string): string {
    const settings = getSettings();
    const root = escapeBashSingleQuoted(cfg.remoteProjectRoot);
    const py = settings.pythonBinary;
    const activation = buildEnvActivation(cfg, py);
    const remoteFile = escapeBashSingleQuoted(
        `${cfg.remoteProjectRoot.replace(/\/+$/, '')}/${remoteRelative.replace(/\\/g, '/')}`
    );
    return `cd '${root}' && ${activation} && PYTHONUNBUFFERED=1 ${py} -u '${remoteFile}'`;
}

function buildRemoteShellCommand(cfg: RemoteConfig): string {
    const root = escapeBashSingleQuoted(cfg.remoteProjectRoot);
    const activation = buildEnvActivation(cfg, getSettings().pythonBinary);
    return `cd '${root}' && ${activation} && unset DISPLAY && exec bash`;
}

// --- Validation ---

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

// --- Debug on Remote ---

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

    const settings = getSettings();

    // Auto-pick a free local port so multiple debug sessions can run simultaneously.
    let port: number;
    try {
        port = await findFreePort();
    } catch {
        port = settings.debugPort;
    }

    const debugSessionName = `Remote Debug: ${path.basename(relativeFile)} (${cfg.host}:${port})`;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Debug on Remote', cancellable: true },
        async (progress, token) => {
            // Step 1: save all buffers (triggers on-save file watcher for each),
            // then explicitly sync the active file to guarantee it's up to date.
            progress.report({ message: 'Syncing...' });
            await vscode.workspace.saveAll(false);
            try {
                await syncFile(cfg, wsPath, relativeFile, output);
            } catch (e) {
                const msg = (e as Error).message;
                vscode.window.showErrorMessage(`Sync failed: ${msg}`);
                return;
            }

            if (token.isCancellationRequested) {
                return;
            }

            // Step 2: start debugpy on a dynamically chosen port
            progress.report({ message: 'Starting debugpy on remote...' });
            output.appendLine(`[plugin] starting remote debug for ${relativeFile} on port ${port}`);

            const remoteCmd = buildRemoteDebugCommand(cfg, relativeFile, port);
            const child = spawn(
                'ssh',
                [
                    '-o', 'ConnectTimeout=10',
                    '-o', 'ServerAliveInterval=30',
                    '-L', `${port}:localhost:${port}`,
                    cfg.host,
                    remoteCmd,
                ],
                { cwd: wsPath, windowsHide: true }
            );

            active = { child, output };

            let attached = false;
            const listeningRegex = /(adapter is accepting incoming client|debugpy.*listening|listening on)/i;
            let buffer = '';
            let stderrBuffer = '';

            const handleChunk = async (chunk: Buffer | string, label: string) => {
                const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
                for (const line of text.split(/\r?\n/)) {
                    if (line.length > 0) {
                        output.appendLine(`[${label}] ${line}`);
                    }
                }
                if (label === 'ssh-err') {
                    stderrBuffer += text;
                }
                if (attached) {
                    return;
                }
                buffer += text;
                if (listeningRegex.test(buffer)) {
                    attached = true;
                    progress.report({ message: 'Attaching debugger...' });
                    output.appendLine(`[plugin] detected debugpy listening; attaching debugger on port ${port}...`);
                    try {
                        // Inline debug config with dynamic port — no launch.json dependency.
                        const ok = await vscode.debug.startDebugging(folder, {
                            type: 'debugpy',
                            request: 'attach',
                            name: debugSessionName,
                            connect: { host: 'localhost', port },
                            pathMappings: [{
                                localRoot: '${workspaceFolder}',
                                remoteRoot: cfg.remoteProjectRoot,
                            }],
                            justMyCode: false,
                        });
                        if (ok) {
                            vscode.window.showInformationMessage(`Debugger attached (port ${port}).`);
                        } else {
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

            token.onCancellationRequested(() => {
                try { child.kill(); } catch { /* ignore */ }
            });

            child.on('close', (code, signal) => {
                output.appendLine(`[plugin] ssh exited (code=${code} signal=${signal})`);
                if (active && active.child === child) {
                    active = undefined;
                }
                if (!attached) {
                    const friendly = parseErrorMessage(stderrBuffer, cfg);
                    vscode.window.showErrorMessage(
                        friendly ??
                        `Remote debugger failed (exit ${code}). See "Remote Debug" output channel.`
                    );
                }
            });

            child.on('error', (err) => {
                output.appendLine(`[plugin] ssh process error: ${err.message}`);
            });

            const sub = vscode.debug.onDidTerminateDebugSession((session) => {
                if (session.name === debugSessionName) {
                    output.appendLine('[plugin] debug session terminated; killing ssh');
                    try { child.kill(); } catch { /* ignore */ }
                    sub.dispose();
                }
            });
        }
    );
}

// --- Run on Remote ---

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

    const settings = getSettings();

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Run on Remote', cancellable: false },
        async (progress) => {
            progress.report({ message: 'Syncing...' });
            await vscode.workspace.saveAll(false);

            const syncLog = vscode.window.createOutputChannel('Remote Run');
            try {
                await syncFile(cfg, wsPath, relativeFile, syncLog);
            } catch (e) {
                const msg = (e as Error).message;
                syncLog.appendLine(`[plugin] sync failed: ${msg}`);
                syncLog.show(true);
                vscode.window.showErrorMessage(`Sync failed: ${msg}`);
                return;
            }

            progress.report({ message: 'Running on remote...' });

            const remoteCmd = buildRemoteRunCommand(cfg, relativeFile);
            const terminal = vscode.window.createTerminal({
                name: `Run on Remote: ${path.basename(fileFsPath)}`,
                shellPath: 'ssh',
                shellArgs: [cfg.host, remoteCmd],
            });
            terminal.show(true);
        }
    );
}

// --- Terminal on Remote ---

export async function openRemoteTerminal(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
    }
    const cfg = loadConfig(folder.uri.fsPath);
    if (!cfg) {
        return;
    }
    const remoteCmd = buildRemoteShellCommand(cfg);
    const terminal = vscode.window.createTerminal({
        name: `Terminal on ${cfg.host}`,
        shellPath: 'ssh',
        shellArgs: ['-t', cfg.host, remoteCmd],
    });
    terminal.show(true);
}

// --- Cleanup ---

export function disposeActive(): void {
    if (active) {
        try { active.child.kill(); } catch { /* ignore */ }
        active = undefined;
    }
}
