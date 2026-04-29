# Changelog

## 1.0.0 (2026-04-29)

First public release.

### Features
- **One-click remote debug**: status bar button "Debug on Remote" — syncs active file, starts debugpy on remote over SSH, forwards port, and auto-attaches Trae's debugger. Set a breakpoint and click.
- **One-click remote run**: status bar button "Run on Remote" — syncs and runs the active file on the remote in a terminal. Stop with Ctrl+C or the trash icon.
- **Cross-platform**: works on Windows, macOS, and Linux. The plugin calls `ssh`/`scp` directly for sync and uses platform-specific shell scripts as fallbacks for manual task usage.
- **Conda env auto-detection**: the setup wizard SSHs into the selected host and probes for conda environments, presenting them as a pick list. Falls back to manual input if detection fails.
- **Auto-install debugpy**: on first debug, debugpy is installed in the remote conda env automatically if missing.
- **Zombie cleanup**: stale debugpy processes from interrupted sessions are automatically killed before each debug run.
- **AI agent rules**: generates `.claude/rules/sshrule.md`, `.trae/rules/sshrule.md`, and `AGENTS.md` so Claude Code, Trae's agent, and Codex can drive the remote workflow.
- **Non-clobbering merge**: re-running the wizard updates plugin-owned entries in `launch.json` and `tasks.json` without overwriting user customizations.
- **SFTP config**: generates `.vscode/sftp.json` for upload-on-save via the VS Code SFTP extension.
