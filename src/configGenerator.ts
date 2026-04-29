import * as path from 'path';
import * as fs from 'fs';
import {
    parse as jsoncParse,
    modify as jsoncModify,
    applyEdits as jsoncApplyEdits,
} from 'jsonc-parser';
import { SshHostEntry } from './sshConfigParser';
import { escapePowerShellSingleQuoted, escapeBashSingleQuoted } from './shellEscape';

export interface GenerateOptions {
    host: SshHostEntry;
    sshConfigPath: string;
    remoteProjectRoot: string;
    envType: 'conda' | 'venv' | 'system';
    condaEnv: string;
    condaRoot: string;
    venvPath: string;
    workspaceRoot: string;
    debugPort: number;
}

function generateSyncScript(opts: GenerateOptions): string {
    const workspaceRoot = escapePowerShellSingleQuoted(opts.workspaceRoot);
    const remoteProjectRoot = escapePowerShellSingleQuoted(opts.remoteProjectRoot);
    const hostAlias = escapePowerShellSingleQuoted(opts.host.host);

    return [
        `param(`,
        `    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]`,
        `    [string[]]$Paths`,
        `)`,
        ``,
        `$ErrorActionPreference = 'Stop'`,
        ``,
        `$workspaceRoot = '${workspaceRoot}'`,
        `$remoteProjectRoot = '${remoteProjectRoot}'`,
        `$hostAlias = '${hostAlias}'`,
        ``,
        `function Get-QuotedRemotePath([string]$Value) {`,
        `    return "'" + $Value.Replace("'", "'\\''") + "'"`,
        `}`,
        ``,
        `function Get-ScpRemoteTarget([string]$HostAlias, [string]$Value) {`,
        `    return $HostAlias + ':' + '"' + $Value.Replace('"', '\\"') + '"'`,
        `}`,
        ``,
        `foreach ($inputPath in $Paths) {`,
        `    if ([string]::IsNullOrWhiteSpace($inputPath)) {`,
        `        throw 'Empty paths are not allowed.'`,
        `    }`,
        ``,
        `    $normalizedRelativePath = $inputPath.Replace('/', [IO.Path]::DirectorySeparatorChar)`,
        `    if ($normalizedRelativePath.StartsWith('.\\') -or $normalizedRelativePath.StartsWith('./')) {`,
        `        $normalizedRelativePath = $normalizedRelativePath.Substring(2)`,
        `    }`,
        `    if ([IO.Path]::IsPathRooted($normalizedRelativePath)) {`,
        `        throw "Path '$inputPath' must be workspace-relative."`,
        `    }`,
        ``,
        `    $localPath = [IO.Path]::GetFullPath((Join-Path $workspaceRoot $normalizedRelativePath))`,
        `    if (-not $localPath.StartsWith($workspaceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {`,
        `        throw "Path '$inputPath' is outside the workspace root."`,
        `    }`,
        `    if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) {`,
        `        throw "Local file not found: $inputPath"`,
        `    }`,
        ``,
        `    $workspaceUri = New-Object System.Uri(($workspaceRoot.TrimEnd('\\') + '\\'))`,
        `    $localUri = New-Object System.Uri($localPath)`,
        `    $relativePath = [System.Uri]::UnescapeDataString($workspaceUri.MakeRelativeUri($localUri).ToString()).Replace('/', '\\')`,
        `    $remoteRelativePath = $relativePath.Replace('\\', '/')`,
        `    $remoteFile = ($remoteProjectRoot.TrimEnd('/') + '/' + $remoteRelativePath)`,
        `    $remoteDir = [System.IO.Path]::GetDirectoryName($remoteRelativePath)`,
        `    if ($null -ne $remoteDir) {`,
        `        $remoteDir = $remoteDir.Replace('\\', '/')`,
        `    }`,
        `    if ([string]::IsNullOrEmpty($remoteDir)) {`,
        `        $remoteParent = $remoteProjectRoot`,
        `    } else {`,
        `        $remoteParent = $remoteProjectRoot.TrimEnd('/') + '/' + $remoteDir`,
        `    }`,
        ``,
        `    & ssh $hostAlias "mkdir -p $(Get-QuotedRemotePath $remoteParent)"`,
        `    if ($LASTEXITCODE -ne 0) {`,
        `        throw "Failed to create remote directory for '$inputPath'."`,
        `    }`,
        ``,
        `    & scp -- $localPath (Get-ScpRemoteTarget $hostAlias $remoteFile)`,
        `    if ($LASTEXITCODE -ne 0) {`,
        `        throw "Failed to upload '$inputPath'."`,
        `    }`,
        ``,
        `    Write-Host "Synced $inputPath -> $remoteFile"`,
        `}`,
        ``,
    ].join('\n');
}

function generateRemoteDebugScript(opts: GenerateOptions): string {
    const workspaceRoot = escapePowerShellSingleQuoted(opts.workspaceRoot);
    const remoteProjectRoot = escapePowerShellSingleQuoted(opts.remoteProjectRoot);
    const hostAlias = escapePowerShellSingleQuoted(opts.host.host);
    const condaEnv = escapePowerShellSingleQuoted(opts.condaEnv);
    const condaRoot = escapePowerShellSingleQuoted(opts.condaRoot);

    return [
        `param(`,
        `    [Parameter(Mandatory = $true)]`,
        `    [string]$File,`,
        `    [int]$Port = ${opts.debugPort}`,
        `)`,
        ``,
        `$ErrorActionPreference = 'Stop'`,
        ``,
        `$workspaceRoot = '${workspaceRoot}'`,
        `$remoteProjectRoot = '${remoteProjectRoot}'`,
        `$hostAlias = '${hostAlias}'`,
        `$condaEnv = '${condaEnv}'`,
        `$condaRoot = '${condaRoot}'`,
        ``,
        `$logFile = Join-Path $workspaceRoot '.vscode/remote-debug.log'`,
        `"=== remote-debug.ps1 run at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Set-Content -Path $logFile -Encoding UTF8`,
        ``,
        `function Write-Log {`,
        `    param([string]$Message)`,
        `    $line = "[$((Get-Date).ToString('HH:mm:ss.fff'))] $Message"`,
        `    Write-Host $line`,
        `    Add-Content -Path $logFile -Value $line -Encoding UTF8`,
        `}`,
        ``,
        `try {`,
        `    Write-Log "File arg: $File"`,
        `    Write-Log "Port: $Port"`,
        `    Write-Log "Host alias: $hostAlias"`,
        `    Write-Log "Conda root: $condaRoot"`,
        `    Write-Log "Conda env: $condaEnv"`,
        `    Write-Log "Workspace root: $workspaceRoot"`,
        `    Write-Log "Remote project root: $remoteProjectRoot"`,
        ``,
        `    if ([string]::IsNullOrWhiteSpace($File)) {`,
        `        throw "No file provided. Open a Python file and make sure it is the active editor before pressing F5."`,
        `    }`,
        ``,
        `    $normalizedRelative = $File.Replace('/', [IO.Path]::DirectorySeparatorChar)`,
        `    if ($normalizedRelative.StartsWith('.\\') -or $normalizedRelative.StartsWith('./')) {`,
        `        $normalizedRelative = $normalizedRelative.Substring(2)`,
        `    }`,
        `    if ([IO.Path]::IsPathRooted($normalizedRelative)) {`,
        `        throw "File '$File' must be workspace-relative."`,
        `    }`,
        ``,
        `    $localPath = [IO.Path]::GetFullPath((Join-Path $workspaceRoot $normalizedRelative))`,
        `    if (-not $localPath.StartsWith($workspaceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {`,
        `        throw "File '$File' is outside the workspace root."`,
        `    }`,
        `    if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) {`,
        `        throw "Local file not found: $localPath"`,
        `    }`,
        ``,
        `    $remoteRelative = $normalizedRelative.Replace('\\', '/')`,
        `    $remoteFile = $remoteProjectRoot.TrimEnd('/') + '/' + $remoteRelative`,
        `    Write-Log "Local path: $localPath"`,
        `    Write-Log "Remote file: $remoteFile"`,
        ``,
        `    Write-Host "starting debugpy on remote..."`,
        `    Add-Content -Path $logFile -Value "[$((Get-Date).ToString('HH:mm:ss.fff'))] starting debugpy on remote..." -Encoding UTF8`,
        ``,
        `    $ensureDebugpy = "(python -c 'import debugpy' 2>/dev/null || (echo 'installing debugpy on first run...' && pip install debugpy))"`,
        `    $cleanupZombies = "(lsof -ti tcp:$Port 2>/dev/null | xargs -r kill 2>/dev/null; sleep 0.3)"`,
        `    $remoteCmd = "cd '$remoteProjectRoot' && source '$condaRoot/etc/profile.d/conda.sh' && conda activate '$condaEnv' && $ensureDebugpy && $cleanupZombies && PYTHONUNBUFFERED=1 python -u -m debugpy --log-to-stderr --listen 0.0.0.0:$Port --wait-for-client '$remoteFile'"`,
        `    Write-Log "Remote command: $remoteCmd"`,
        `    Write-Log "Spawning: ssh -L $($Port):localhost:$Port $hostAlias <remoteCmd>"`,
        ``,
        `    $origErrPref = $ErrorActionPreference`,
        `    $ErrorActionPreference = 'Continue'`,
        `    try {`,
        `        & ssh -L "$($Port):localhost:$Port" $hostAlias $remoteCmd 2>&1 | ForEach-Object {`,
        `            $sshLine = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_.ToString() }`,
        `            Write-Host $sshLine`,
        `            Add-Content -Path $logFile -Value "[$((Get-Date).ToString('HH:mm:ss.fff'))] [ssh] $sshLine" -Encoding UTF8`,
        `        }`,
        `    } finally {`,
        `        $ErrorActionPreference = $origErrPref`,
        `    }`,
        ``,
        `    $sshExit = $LASTEXITCODE`,
        `    Write-Log "SSH exit code: $sshExit"`,
        `    if ($sshExit -ne 0) {`,
        `        throw "Remote debugpy session exited with code $sshExit. See $logFile for details."`,
        `    }`,
        `} catch {`,
        `    Write-Log "ERROR: $_"`,
        `    Write-Log "Stack: $($_.ScriptStackTrace)"`,
        `    throw`,
        `}`,
        ``,
    ].join('\n');
}

function generateSyncShellScript(opts: GenerateOptions): string {
    const remoteProjectRoot = escapeBashSingleQuoted(opts.remoteProjectRoot);
    const hostAlias = escapeBashSingleQuoted(opts.host.host);

    return [
        `#!/usr/bin/env bash`,
        `set -euo pipefail`,
        ``,
        `WORKSPACE_ROOT='${escapeBashSingleQuoted(opts.workspaceRoot)}'`,
        `REMOTE_PROJECT_ROOT='${remoteProjectRoot}'`,
        `HOST_ALIAS='${hostAlias}'`,
        ``,
        `if [ $# -eq 0 ]; then`,
        `  echo "Usage: $0 <workspace-relative-path> [...]" >&2`,
        `  exit 1`,
        `fi`,
        ``,
        `for input_path in "$@"; do`,
        `  if [ -z "$input_path" ]; then`,
        `    echo "Error: empty paths are not allowed." >&2; exit 1`,
        `  fi`,
        ``,
        `  rel="\${input_path#./}"`,
        `  case "$rel" in /*) echo "Error: path '$input_path' must be workspace-relative." >&2; exit 1;; esac`,
        ``,
        `  local_path="$WORKSPACE_ROOT/$rel"`,
        `  if [ ! -f "$local_path" ]; then`,
        `    echo "Error: local file not found: $input_path" >&2; exit 1`,
        `  fi`,
        ``,
        `  remote_rel="$(echo "$rel" | tr '\\\\' '/')"`,
        `  remote_file="$REMOTE_PROJECT_ROOT/$remote_rel"`,
        `  remote_dir="$(dirname "$remote_file")"`,
        ``,
        `  ssh "$HOST_ALIAS" "mkdir -p '$(echo "$remote_dir" | sed "s/'/'\\\\''/g")'"`,
        `  scp -- "$local_path" "$HOST_ALIAS:$remote_file"`,
        `  echo "Synced $input_path -> $remote_file"`,
        `done`,
        ``,
    ].join('\n');
}

function generateRemoteDebugShellScript(opts: GenerateOptions): string {
    const remoteProjectRoot = escapeBashSingleQuoted(opts.remoteProjectRoot);
    const hostAlias = escapeBashSingleQuoted(opts.host.host);
    const condaEnv = escapeBashSingleQuoted(opts.condaEnv);
    const condaRoot = escapeBashSingleQuoted(opts.condaRoot);

    return [
        `#!/usr/bin/env bash`,
        `set -euo pipefail`,
        ``,
        `FILE="\${1:?Usage: $0 <workspace-relative-file> [port]}"`,
        `PORT="\${2:-${opts.debugPort}}"`,
        ``,
        `WORKSPACE_ROOT='${escapeBashSingleQuoted(opts.workspaceRoot)}'`,
        `REMOTE_PROJECT_ROOT='${remoteProjectRoot}'`,
        `HOST_ALIAS='${hostAlias}'`,
        `CONDA_ENV='${condaEnv}'`,
        `CONDA_ROOT='${condaRoot}'`,
        ``,
        `rel="\${FILE#./}"`,
        `remote_rel="$(echo "$rel" | tr '\\\\' '/')"`,
        `remote_file="$REMOTE_PROJECT_ROOT/$remote_rel"`,
        ``,
        `echo "starting debugpy on remote..."`,
        ``,
        `ssh -L "$PORT:localhost:$PORT" "$HOST_ALIAS" \\`,
        `  "cd '$REMOTE_PROJECT_ROOT' && \\`,
        `   source '$CONDA_ROOT/etc/profile.d/conda.sh' && \\`,
        `   conda activate '$CONDA_ENV' && \\`,
        `   (python -c 'import debugpy' 2>/dev/null || (echo 'installing debugpy...' && pip install debugpy)) && \\`,
        `   (lsof -ti tcp:$PORT 2>/dev/null | xargs -r kill 2>/dev/null; sleep 0.3) && \\`,
        `   PYTHONUNBUFFERED=1 python -u -m debugpy --log-to-stderr --listen 0.0.0.0:$PORT --wait-for-client '$remote_file'"`,
        ``,
    ].join('\n');
}

const FORMATTING = { tabSize: 4, insertSpaces: true, eol: '\n' };

function replacePluginEntries(
    existingText: string,
    arrayPath: string[],
    keyField: string,
    ownedNames: string[],
    additions: any[]
): string {
    let text = existingText;

    const findArray = (): any[] | undefined => {
        const parsed = jsoncParse(text) ?? {};
        let cur: any = parsed;
        for (const seg of arrayPath) {
            cur = cur?.[seg];
        }
        return Array.isArray(cur) ? (cur as any[]) : undefined;
    };

    let arr = findArray();
    if (arr === undefined) {
        if (additions.length === 0) {
            return text;
        }
        const edits = jsoncModify(text, arrayPath, [], { formattingOptions: FORMATTING });
        text = jsoncApplyEdits(text, edits);
        arr = findArray() ?? [];
    }

    // Remove every existing entry whose key is in ownedNames (legacy + current).
    // Iterate by repeatedly searching from index 0; jsonc-parser's modify shifts
    // remaining elements down, so the next find restarts from the new state.
    while (true) {
        const cur = findArray() ?? [];
        const idx = cur.findIndex(
            (e) => typeof e?.[keyField] === 'string' && ownedNames.includes(e[keyField])
        );
        if (idx < 0) {
            break;
        }
        const edits = jsoncModify(text, [...arrayPath, idx], undefined, {
            formattingOptions: FORMATTING,
        });
        text = jsoncApplyEdits(text, edits);
    }

    // Append fresh entries.
    for (const item of additions) {
        const cur = findArray() ?? [];
        const edits = jsoncModify(text, [...arrayPath, cur.length], item, {
            formattingOptions: FORMATTING,
            isArrayInsertion: true,
        });
        text = jsoncApplyEdits(text, edits);
    }

    return text;
}

function writeOrMergeJson(
    filePath: string,
    freshContent: () => any,
    mergePlans: { arrayPath: string[]; keyField: string; ownedNames: string[]; additions: any[] }[]
): void {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(freshContent(), null, 4) + '\n', 'utf-8');
        return;
    }
    const existing = fs.readFileSync(filePath, 'utf-8');
    let parsed: any;
    try {
        parsed = jsoncParse(existing);
    } catch {
        parsed = undefined;
    }
    if (parsed === undefined || parsed === null) {
        return;
    }
    let text = existing;
    for (const plan of mergePlans) {
        text = replacePluginEntries(text, plan.arrayPath, plan.keyField, plan.ownedNames, plan.additions);
    }
    fs.writeFileSync(filePath, text, 'utf-8');
}

function buildLaunchConfigurations(opts: GenerateOptions): any[] {
    return [
        {
            name: 'Run on Remote (Python)',
            type: 'debugpy',
            request: 'attach',
            connect: { host: 'localhost', port: opts.debugPort },
            pathMappings: [
                {
                    localRoot: '${workspaceFolder}',
                    remoteRoot: opts.remoteProjectRoot,
                },
            ],
            justMyCode: false,
            // Hide from the F5 dropdown so users don't accidentally pick a pure-attach
            // config that has nothing to attach to. The plugin's "Debug on Remote"
            // button invokes this programmatically, which still works when hidden.
            presentation: { hidden: true },
        },
    ];
}

function buildTasks(opts: GenerateOptions): any[] {
    const alias = opts.host.host;
    const remoteRoot = opts.remoteProjectRoot;
    const env = opts.condaEnv;
    const condaRoot = opts.condaRoot;
    const port = opts.debugPort;
    const condaInit = `source '${condaRoot}/etc/profile.d/conda.sh'`;

    return [
        {
            label: 'remote-sync',
            type: 'shell',
            command: 'bash',
            args: [
                '${workspaceFolder}/.vscode/sync-remote.sh',
                '${relativeFile}',
            ],
            windows: {
                command: 'powershell',
                args: [
                    '-ExecutionPolicy', 'Bypass',
                    '-File', '${workspaceFolder}/.vscode/sync-remote.ps1',
                    '${relativeFile}',
                ],
            },
            presentation: { reveal: 'silent', panel: 'shared' },
            problemMatcher: [],
        },
        {
            label: 'remote-run',
            type: 'shell',
            dependsOn: 'remote-sync',
            command: 'ssh',
            args: [
                alias,
                `cd '${remoteRoot}' && ${condaInit} && conda activate '${env}' && python -u '${remoteRoot}/\${relativeFile/\\\\/\\//g}'`,
            ],
            presentation: { reveal: 'always', panel: 'dedicated' },
            problemMatcher: [],
        },
        {
            label: 'remote-debug-launch',
            type: 'shell',
            dependsOn: 'remote-sync',
            command: 'bash',
            args: [
                '${workspaceFolder}/.vscode/remote-debug.sh',
                '${relativeFile}',
                String(port),
            ],
            windows: {
                command: 'powershell',
                args: [
                    '-ExecutionPolicy', 'Bypass',
                    '-File', '${workspaceFolder}/.vscode/remote-debug.ps1',
                    '-File', '${relativeFile}',
                    '-Port', String(port),
                ],
            },
            isBackground: true,
            presentation: { reveal: 'always', panel: 'dedicated' },
            problemMatcher: [
                {
                    pattern: [{ regexp: '.', file: 1, location: 2, message: 3 }],
                    background: {
                        activeOnStart: true,
                        beginsPattern: 'starting debugpy on remote',
                        endsPattern: `Listening on .*:${port}`,
                    },
                },
            ],
        },
        {
            label: 'remote-install-debugpy',
            type: 'shell',
            command: 'ssh',
            args: [
                alias,
                `${condaInit} && conda activate '${env}' && pip install debugpy`,
            ],
            presentation: { reveal: 'always', panel: 'dedicated' },
            problemMatcher: [],
        },
    ];
}

// Names this plugin owns in launch.json/tasks.json. Includes legacy names from
// previous versions so they get cleaned up on regenerate. Anything outside this
// list is treated as user-owned and left untouched.
const OWNED_LAUNCH_CONFIG_NAMES = [
    'Run on Remote (Python)',
    'Attach to Remote debugpy', // legacy: was a separate attach config in <=0.2.0
];
const OWNED_LAUNCH_COMPOUND_NAMES = [
    'Run on Remote (Python)', // legacy: was a compound in <=0.2.0
];
const OWNED_TASK_LABELS = [
    'remote-sync',
    'remote-run',
    'remote-debug-launch',
    'remote-install-debugpy',
];

function generateLaunchJson(vscodeDir: string, opts: GenerateOptions): void {
    const filePath = path.join(vscodeDir, 'launch.json');
    const configurations = buildLaunchConfigurations(opts);
    writeOrMergeJson(
        filePath,
        () => ({ version: '0.2.0', configurations }),
        [
            {
                arrayPath: ['configurations'],
                keyField: 'name',
                ownedNames: OWNED_LAUNCH_CONFIG_NAMES,
                additions: configurations,
            },
            {
                arrayPath: ['compounds'],
                keyField: 'name',
                ownedNames: OWNED_LAUNCH_COMPOUND_NAMES,
                additions: [], // no longer generating compounds
            },
        ]
    );
}

function generateTasksJson(vscodeDir: string, opts: GenerateOptions): void {
    const filePath = path.join(vscodeDir, 'tasks.json');
    const tasks = buildTasks(opts);
    writeOrMergeJson(
        filePath,
        () => ({ version: '2.0.0', tasks }),
        [
            {
                arrayPath: ['tasks'],
                keyField: 'label',
                ownedNames: OWNED_TASK_LABELS,
                additions: tasks,
            },
        ]
    );
}

export function generateAll(opts: GenerateOptions): void {
    const sshCommand = `ssh ${opts.host.host} "cd ${opts.remoteProjectRoot} && conda activate ${opts.condaEnv} && <command>"`;
    const syncPs1 = `powershell -ExecutionPolicy Bypass -File .vscode/sync-remote.ps1 path/to/file.py`;
    const syncBash = `bash .vscode/sync-remote.sh path/to/file.py`;

    const syncScriptContent = generateSyncScript(opts);
    const syncShellContent = generateSyncShellScript(opts);
    const remoteDebugPs1Content = generateRemoteDebugScript(opts);
    const remoteDebugShContent = generateRemoteDebugShellScript(opts);

    const ruleContent = [
        `# Remote Development Rules`,
        ``,
        `## Workflow`,
        `1. **Edit locally only** - NEVER edit files directly on the remote machine.`,
        `2. After creating or modifying files, run the sync helper for the touched workspace-relative paths.`,
        `3. Before any remote Python/test command, run the sync helper again for all touched files in the current task.`,
        `4. Run and test on the remote via SSH only after sync succeeds.`,
        ``,
        `## SSH Connection`,
        `- Host alias: \`${opts.host.host}\``,
        `- SSH config: \`${opts.sshConfigPath}\``,
        `- Remote project root: \`${opts.remoteProjectRoot}\``,
        `- Conda env: \`${opts.condaEnv}\``,
        ``,
        `## Syncing Files`,
        `Use the generated local sync helper to upload touched files deterministically:`,
        `\`\`\`powershell`,
        `# Windows`,
        syncPs1,
        `\`\`\``,
        `\`\`\`bash`,
        `# macOS / Linux`,
        syncBash,
        `\`\`\``,
        `SFTP \`uploadOnSave: true\` is best-effort convenience only. Always run the helper after edits and again before remote execution.`,
        ``,
        `## Running Code`,
        `Sync first, then execute commands on the remote:`,
        `\`\`\`bash`,
        `# After syncing, run on remote via SSH:`,
        sshCommand,
        `\`\`\``,
        ``,
        `## Rules`,
        `- NEVER run code locally. Always run on the remote.`,
        `- NEVER create, edit, or delete files on the remote. All edits happen locally.`,
        `- The sync helper accepts one or more workspace-relative file paths and uploads only those touched files.`,
        `- SFTP auto-upload may lag or miss new files, so do not rely on save alone for correctness.`,
        `- If a test fails, edit the code locally, sync the touched files again, then re-run on the remote.`,
        ``,
    ].join('\n');

    const agentsContent = [
        `# AGENTS.md`,
        ``,
        `Codex should follow this remote development workflow for this repository.`,
        ``,
        `## Workflow`,
        `1. Edit files locally only. Never create, edit, or delete files directly on the remote machine.`,
        `2. After creating or modifying files, run the sync helper for the touched workspace-relative paths.`,
        `3. Before any remote Python/test command, run the sync helper again for all touched files in the current task.`,
        `4. Run and test on the remote via SSH only after sync succeeds.`,
        ``,
        `## SSH Connection`,
        `- Host alias: \`${opts.host.host}\``,
        `- SSH config: \`${opts.sshConfigPath}\``,
        `- Remote project root: \`${opts.remoteProjectRoot}\``,
        `- Conda env: \`${opts.condaEnv}\``,
        ``,
        `## Syncing Files`,
        `Use the generated local sync helper to upload touched files deterministically:`,
        `\`\`\`powershell`,
        `# Windows`,
        syncPs1,
        `\`\`\``,
        `\`\`\`bash`,
        `# macOS / Linux`,
        syncBash,
        `\`\`\``,
        `SFTP \`uploadOnSave: true\` is best-effort convenience only. Always run the helper after edits and again before remote execution.`,
        ``,
        `## Running Code`,
        `Sync first, then execute commands on the remote:`,
        `\`\`\`bash`,
        `# After syncing, run on remote via SSH:`,
        sshCommand,
        `\`\`\``,
        ``,
        `## Rules`,
        `- NEVER run code locally. Always run on the remote.`,
        `- NEVER create, edit, or delete files on the remote. All edits happen locally.`,
        `- The sync helper accepts one or more workspace-relative file paths and uploads only those touched files.`,
        `- SFTP auto-upload may lag or miss new files, so do not rely on save alone for correctness.`,
        `- If a test fails, edit the code locally, sync the touched files again, then re-run on the remote.`,
        ``,
    ].join('\n');

    const claudeDir = path.join(opts.workspaceRoot, '.claude', 'rules');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'sshrule.md'), ruleContent, 'utf-8');

    const traeDir = path.join(opts.workspaceRoot, '.trae', 'rules');
    fs.mkdirSync(traeDir, { recursive: true });
    fs.writeFileSync(path.join(traeDir, 'sshrule.md'), ruleContent, 'utf-8');

    const vscodeDir = path.join(opts.workspaceRoot, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    const sftp = {
        name: opts.host.host,
        host: opts.host.hostName,
        protocol: 'sftp',
        port: opts.host.port,
        username: opts.host.user,
        privateKeyPath: process.platform === 'win32'
            ? (opts.host.identityFile?.replace(/\//g, '\\') || '')
            : (opts.host.identityFile || ''),
        remotePath: opts.remoteProjectRoot,
        uploadOnSave: true,
        useTempFile: false,
        openSsh: true,
    };
    fs.writeFileSync(
        path.join(vscodeDir, 'sftp.json'),
        JSON.stringify(sftp, null, 4) + '\n',
        'utf-8'
    );
    fs.writeFileSync(path.join(vscodeDir, 'sync-remote.ps1'), syncScriptContent, 'utf-8');
    fs.writeFileSync(path.join(vscodeDir, 'sync-remote.sh'), syncShellContent, 'utf-8');
    fs.writeFileSync(path.join(vscodeDir, 'remote-debug.ps1'), remoteDebugPs1Content, 'utf-8');
    fs.writeFileSync(path.join(vscodeDir, 'remote-debug.sh'), remoteDebugShContent, 'utf-8');

    const pluginConfig = {
        host: opts.host.host,
        remoteProjectRoot: opts.remoteProjectRoot,
        envType: opts.envType,
        condaRoot: opts.condaRoot || undefined,
        condaEnv: opts.condaEnv || undefined,
        venvPath: opts.venvPath || undefined,
        debugPort: opts.debugPort,
    };
    fs.writeFileSync(
        path.join(vscodeDir, 'remote-config-gen.json'),
        JSON.stringify(pluginConfig, null, 4) + '\n',
        'utf-8'
    );

    generateLaunchJson(vscodeDir, opts);
    generateTasksJson(vscodeDir, opts);

    fs.writeFileSync(path.join(opts.workspaceRoot, 'AGENTS.md'), agentsContent, 'utf-8');
}
