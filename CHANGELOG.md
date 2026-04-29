# Changelog

## 1.1.0 (2026-04-29)

### New Features
- **Virtualenv / venv / system Python support**: the wizard now asks "How is Python managed on your remote?" with three options (Conda, Virtualenv, System Python). This opens the plugin to ~75% more Python developers beyond conda users.
- **Project-wide sync**: replaced single-file scp with `tar | ssh` bulk sync. All workspace files are synced before run/debug (excluding `__pycache__`, `.git`, `node_modules`, etc.). No more stale imports.
- **Auto-save before sync**: `saveAll()` is called before every sync so unsaved buffer edits always reach the remote.
- **Progress notifications**: "Saving & syncing project..." / "Starting debugpy..." / "Attaching debugger..." progress bar with cancel support during debug/run operations.
- **Terminal on Remote**: new status bar button opens an SSH shell on the remote with your Python env activated.
- **Auto-sync on save**: built-in file watcher syncs saved files to remote in the background. No more dependency on the third-party SFTP extension for sync.
- **Conditional status bar buttons**: Debug/Run/Terminal buttons only appear in workspaces that have been set up with the wizard.
- **VS Code settings**: configurable `debugPort`, `pythonBinary`, and `syncExcludes` via Settings UI.
- **Actionable error messages**: common failures (connection refused, env not found, module missing, port busy) produce clear messages with fix suggestions instead of raw stderr.

### Improvements
- Declared `ms-python.debugpy` as extension dependency.
- Better description and keywords for marketplace discoverability.

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
