import * as vscode from 'vscode';
import { runGenerateFlow } from './multiStepInput';
import { runRemoteDebug, runRemoteRun, disposeActive } from './remoteDebugCommand';

export function activate(context: vscode.ExtensionContext) {
    const generateCmd = vscode.commands.registerCommand(
        'remote-config-gen.generate',
        () => runGenerateFlow()
    );
    context.subscriptions.push(generateCmd);

    const debugCmd = vscode.commands.registerCommand(
        'remote-config-gen.runDebug',
        () => runRemoteDebug()
    );
    context.subscriptions.push(debugCmd);

    const runCmd = vscode.commands.registerCommand(
        'remote-config-gen.runRemote',
        () => runRemoteRun()
    );
    context.subscriptions.push(runCmd);

    const debugStatus = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
    );
    debugStatus.command = 'remote-config-gen.runDebug';
    debugStatus.text = '$(debug-alt) Debug on Remote';
    debugStatus.tooltip = 'Sync active file, start debugpy on remote, attach Trae debugger';
    debugStatus.show();
    context.subscriptions.push(debugStatus);

    const runStatus = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        99
    );
    runStatus.command = 'remote-config-gen.runRemote';
    runStatus.text = '$(play) Run on Remote';
    runStatus.tooltip = 'Sync active file and run it on the remote (no debugger)';
    runStatus.show();
    context.subscriptions.push(runStatus);

    context.subscriptions.push({
        dispose: disposeActive,
    });
}

export function deactivate() {
    disposeActive();
}
