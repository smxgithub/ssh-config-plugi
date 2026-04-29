import { execFile } from 'child_process';

export interface CondaEnv {
    name: string;
    path: string;
}

export interface CondaProbeResult {
    envs: CondaEnv[];
    condaRoot: string;
}

export class CondaProbeError extends Error {
    constructor(message: string, public readonly cause?: string) {
        super(message);
        this.name = 'CondaProbeError';
    }
}

export function parseCondaEnvList(stdout: string): CondaEnv[] {
    const envs: CondaEnv[] = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const tokens = line.split(/\s+/).filter((t) => t.length > 0 && t !== '*');
        if (tokens.length < 2) {
            continue;
        }
        const name = tokens[0];
        const envPath = tokens[tokens.length - 1];
        if (!envPath.startsWith('/')) {
            continue;
        }
        envs.push({ name, path: envPath });
    }
    return envs;
}

export function deriveCondaRoot(envs: CondaEnv[]): string | undefined {
    const base = envs.find((e) => e.name === 'base');
    if (base) {
        return base.path;
    }
    // Fallback: a non-base env path looks like <root>/envs/<name>; strip the suffix.
    for (const e of envs) {
        const idx = e.path.lastIndexOf('/envs/');
        if (idx > 0) {
            return e.path.substring(0, idx);
        }
    }
    return undefined;
}

const REMOTE_PROBE_SCRIPT = [
    `for p in $HOME/miniconda3 $HOME/anaconda3 $HOME/.conda $HOME/miniforge3 /opt/conda /opt/anaconda3 /opt/miniconda3; do [ -x "$p/bin/conda" ] && "$p/bin/conda" env list && exit 0; done`,
    `command -v conda >/dev/null 2>&1 && conda env list && exit 0`,
    `[ -f "$HOME/.bashrc" ] && bash -c '. "$HOME/.bashrc" >/dev/null 2>&1; conda env list' && exit 0`,
    `echo "conda not found" >&2`,
    `exit 127`,
].join('\n');

export function detectCondaEnvs(
    hostAlias: string,
    timeoutMs: number = 10_000
): Promise<CondaProbeResult> {
    return new Promise((resolve, reject) => {
        execFile(
            'ssh',
            [
                '-o', 'ConnectTimeout=10',
                '-o', 'StrictHostKeyChecking=accept-new',
                hostAlias,
                REMOTE_PROBE_SCRIPT,
            ],
            { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
                    if (killed) {
                        reject(new CondaProbeError(`SSH detection timed out after ${timeoutMs}ms.`));
                        return;
                    }
                    const detail = (stderr || err.message || '').trim();
                    reject(new CondaProbeError('SSH detection failed.', detail));
                    return;
                }
                const envs = parseCondaEnvList(stdout);
                if (envs.length === 0) {
                    const detail = (stderr || stdout || '').trim();
                    reject(new CondaProbeError(
                        'No conda envs detected. The remote may not have conda installed, or it lives in a non-standard path.',
                        detail || undefined
                    ));
                    return;
                }
                const condaRoot = deriveCondaRoot(envs);
                if (!condaRoot) {
                    reject(new CondaProbeError('Detected envs but could not infer conda root path.'));
                    return;
                }
                resolve({ envs, condaRoot });
            }
        );
    });
}
