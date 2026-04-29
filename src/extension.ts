import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { runGenerateFlow } from './multiStepInput';
import {
    runRemoteDebug,
    runRemoteRun,
    openRemoteTerminal,
    disposeActive,
    loadConfig,
    syncFile,
} from './remoteDebugCommand';

let debugButton: vscode.StatusBarItem | undefined;
let runButton: vscode.StatusBarItem | undefined;
let terminalButton: vscode.StatusBarItem | undefined;

function configExists(): boolean {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
        return false;
    }
    return fs.existsSync(path.join(ws.uri.fsPath, '.vscode', 'remote-config-gen.json'));
}

function updateButtonVisibility(): void {
    if (configExists()) {
        debugButton?.show();
        runButton?.show();
        terminalButton?.show();
    } else {
        debugButton?.hide();
        runButton?.hide();
        terminalButton?.hide();
    }
}

export function activate(context: vscode.ExtensionContext) {
    const generateCmd = vscode.commands.registerCommand(
        'remote-config-gen.generate',
        async () => {
            await runGenerateFlow();
            updateButtonVisibility();
        }
    );
    context.subscriptions.push(generateCmd);

    context.subscriptions.push(
        vscode.commands.registerCommand('remote-config-gen.runDebug', () => runRemoteDebug())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('remote-config-gen.runRemote', () => runRemoteRun())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('remote-config-gen.openTerminal', () => openRemoteTerminal())
    );

    debugButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    debugButton.command = 'remote-config-gen.runDebug';
    debugButton.text = '$(debug-alt) Debug on Remote';
    debugButton.tooltip = 'Save all, sync project, start debugpy on remote, attach debugger';
    context.subscriptions.push(debugButton);

    runButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    runButton.command = 'remote-config-gen.runRemote';
    runButton.text = '$(play) Run on Remote';
    runButton.tooltip = 'Save all, sync project, run active file on remote';
    context.subscriptions.push(runButton);

    terminalButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    terminalButton.command = 'remote-config-gen.openTerminal';
    terminalButton.text = '$(terminal) Terminal on Remote';
    terminalButton.tooltip = 'Open an SSH terminal on the remote with your Python env activated';
    context.subscriptions.push(terminalButton);

    updateButtonVisibility();

    const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/remote-config-gen.json');
    watcher.onDidCreate(() => updateButtonVisibility());
    watcher.onDidDelete(() => updateButtonVisibility());
    context.subscriptions.push(watcher);

    // Auto-sync on save: when a file is saved, sync it to remote in the background.
    const syncOutput = vscode.window.createOutputChannel('Remote Auto-Sync');
    const onSave = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (!configExists()) {
            return;
        }
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            return;
        }
        const wsPath = ws.uri.fsPath;
        const rel = path.relative(wsPath, doc.uri.fsPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return;
        }
        // Skip non-source files
        if (rel.startsWith('.vscode') || rel.startsWith('.git') || rel.startsWith('node_modules')) {
            return;
        }
        const cfg = loadConfig(wsPath);
        if (!cfg) {
            return;
        }
        try {
            await syncFile(cfg, wsPath, rel, syncOutput);
        } catch {
            // Silent — background sync failure is not critical
        }
    });
    context.subscriptions.push(onSave);

    context.subscriptions.push({ dispose: disposeActive });
}

export function deactivate() {
    disposeActive();
}
