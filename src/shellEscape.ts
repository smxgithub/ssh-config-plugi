export function escapeBashSingleQuoted(value: string): string {
    return value.replace(/'/g, "'\\''");
}

export function escapePowerShellSingleQuoted(value: string): string {
    return value.replace(/'/g, "''");
}
