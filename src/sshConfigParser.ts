import * as fs from 'fs';
import SSHConfig from 'ssh-config';

export interface SshHostEntry {
    host: string;
    hostName: string;
    port: number;
    user: string;
    identityFile?: string;
}

export function parseSshConfig(configPath: string): SshHostEntry[] {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = SSHConfig.parse(content);
    const seen = new Set<string>();
    const entries: SshHostEntry[] = [];

    for (const section of config) {
        if (section.type !== SSHConfig.DIRECTIVE || section.param !== 'Host') {
            continue;
        }
        const hostAlias = section.value as string;
        if (hostAlias === '*') {
            continue;
        }

        const computed = config.compute(hostAlias);
        const first = (v: string | string[] | undefined): string | undefined =>
            Array.isArray(v) ? v[0] : v;
        const hostName = first(computed['HostName']) || hostAlias;
        const port = parseInt(first(computed['Port']) || '22', 10);
        const user = first(computed['User']) || '';
        const identityFile = first(computed['IdentityFile']);

        const key = `${hostAlias}|${hostName}|${port}|${user}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);

        entries.push({ host: hostAlias, hostName, port, user, identityFile });
    }

    return entries;
}
