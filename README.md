# Terminal File Actions

**Click any file path in your terminal. Get instant git & file actions.**

A lightweight VS Code / code-server extension that detects file paths in terminal output (`git status`, `ls`, `diff`, etc.) and shows a quick-pick menu to stage, diff, open, copy, and more -- all without leaving the terminal.

Every action is **fully customizable**: add your own commands, remove the ones you don't need, or rearrange the menu to fit your workflow. Suggestions and contributions are welcome -- [open an issue](https://github.com/julien-/terminal-file-actions/issues) or submit a PR!

![VS Code](https://img.shields.io/badge/VS%20Code-1.70%2B-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![License](https://img.shields.io/badge/license-MIT-green)

![crop](https://github.com/user-attachments/assets/148080e3-4e1a-4c3c-889e-76ff654558d1)

## Why?

Working in the terminal means constantly switching context: copy a path, open a file, run a git command, go back. This extension turns every file path in your terminal into a clickable shortcut. One click, pick an action, done.

## Default actions

Click on any detected file path in the terminal to open an action menu:

**Git**
- `git add` + `git status` -- Stage file and show status
- `git checkout` -- Discard changes
- `git diff` -- Show changes
- `git rm` -- Remove file
- `git reset` -- Unstage file

**File**
- Open in Editor
- Copy path / Paste path / Copy filename
- Reveal in Explorer

## Detected patterns

The extension recognizes file paths from a wide range of terminal outputs:

| Source | Examples |
|--------|----------|
| `git status` (long) | `modified: src/app.ts`, `new file: README.md`, `deleted: old.js` |
| `git status` (short) | `M src/app.ts`, `?? newfile.txt`, `AM index.js` |
| `git status` (untracked) | Bare indented paths like `lib/utils/` or `.env` |
| Merge conflicts | `both modified: config.yaml` |
| `git diff` headers | `diff --git a/file b/file`, `--- a/file`, `+++ b/file` |
| `diff --stat` | `src/app.ts \| 5 +++--` |
| Dotfiles | `.gitignore`, `.env.local`, `.eslintrc.json` |
| General paths | `src/components/Button.tsx`, `./config/settings.json` |
| `ls` output | `package.json`, `file.txt` (any file with an extension) |

ANSI color codes (from git, grep, ls --color, etc.) are automatically stripped before matching.

## Custom commands

The action menu is **fully configurable**. The default commands are defined in [`commands.default.json`](commands.default.json). Override them in your VS Code `settings.json`:

```jsonc
"terminalContextMenu.commands": [
  {
    "label": "git add",
    "icon": "git-commit",
    "detail": "Stage file",
    "command": "git add \"{file}\" && git status{Enter}",
    "group": "git"
  },
  {
    "label": "git diff",
    "icon": "diff",
    "action": "diff",
    "group": "git"
  },
  {
    "label": "Open in Editor",
    "icon": "file",
    "action": "openFile",
    "group": "file"
  }
]
```

### Command format

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Display name in the menu (required) |
| `icon` | string | [Codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) name (without `$()`) |
| `detail` | string | Secondary description shown below the label |
| `command` | string | Shell command sent to terminal (supports placeholders and special markers) |
| `action` | string | Built-in action (see below) |
| `vscodeCommand` | string | Any VS Code command ID (e.g. `vscode.open`, `editor.action.formatDocument`) |
| `args` | array | Arguments for `vscodeCommand` (string args support placeholders) |
| `group` | string | Group name -- items with the same group are visually grouped |

### Special markers

Shell commands (`command` field) support two special markers:

| Marker | Description |
|--------|-------------|
| `{Enter}` | Append at the end to auto-execute the command. Without it, the command is typed but not sent. |
| `{confirm:message}` | Show a Yes/No confirmation dialog before running. Aborts if the user clicks No. |

Example: `"command": "git add \"{file}\"{Enter}"` stages the file immediately.
Example: `"command": "{confirm:Delete this file?}rm \"{file}\"{Enter}"` asks for confirmation first.

### Placeholders

Available in `command` and `vscodeCommand` `args`:

| Placeholder | Example for `src/utils/helper.ts` |
|-------------|-----------------------------------|
| `{file}` | `src/utils/helper.ts` |
| `{absPath}` | `/home/user/project/src/utils/helper.ts` |
| `{dir}` | `src/utils` |
| `{name}` | `helper.ts` |
| `{ext}` | `ts` |

### Built-in actions

| Action | Description |
|--------|-------------|
| `diff` | Open git diff in editor (tries unstaged then staged) |
| `openFile` | Open the file in the editor |
| `copyPath` | Copy the full absolute path |
| `pastePath` | Paste the absolute path into the terminal (without executing) |
| `copyDir` | Copy the parent directory path |
| `copyName` | Copy just the filename |
| `revealFile` | Reveal in the Explorer sidebar |

### Examples

Shell command with placeholders:

```jsonc
{
  "label": "git blame",
  "icon": "person",
  "command": "git blame \"{file}\"",
  "group": "git"
}
```

```jsonc
{
  "label": "Copy extension",
  "icon": "symbol-string",
  "command": "echo \"{ext}\" | xclip -selection clipboard",
  "group": "copy"
}
```

VS Code command:

```jsonc
{
  "label": "Open containing folder",
  "icon": "folder-opened",
  "vscodeCommand": "revealFileInOS",
  "args": ["{absPath}"],
  "group": "file"
}
```

```jsonc
{
  "label": "Search in directory",
  "icon": "search",
  "vscodeCommand": "workbench.action.findInFiles",
  "args": [{ "filesToInclude": "{dir}" }],
  "group": "file"
}
```

## Installation

### From VSIX (recommended)

```bash
# Package the extension
npx @vscode/vsce package

# Install in VS Code
code --install-extension terminal-file-actions-*.vsix

# Or in code-server
code-server --install-extension terminal-file-actions-*.vsix
```

### From source

```bash
git clone https://github.com/julien-/terminal-file-actions.git
cd terminal-file-actions
npm install
npm run compile
```

Then copy the project folder to your VS Code extensions directory, or create a symlink:

```bash
# Linux/macOS
ln -s "$(pwd)" ~/.vscode/extensions/terminal-file-actions

# code-server
ln -s "$(pwd)" ~/.local/share/code-server/extensions/terminal-file-actions
```

## How it works

The extension registers a `TerminalLinkProvider` that scans each terminal line through three layers of pattern matching:

1. **Git status patterns** (highest priority) -- matches `modified:`, `new file:`, short status codes like `M`, `??`, `AM`
2. **Command output patterns** -- matches `diff --git`, `--- a/`, `+++ b/`, diff stat lines
3. **General file path patterns** (fallback) -- matches paths with `/` separators, dotfiles, and files with extensions

When a match is found, the file path is underlined in the terminal. Clicking it opens a quick-pick menu with the available actions.

## Requirements

- VS Code 1.70+ or compatible (code-server, VSCodium, Cursor, etc.)
- Git (for git actions to work)

## Known limitations

- Extensionless files without a directory prefix (`Makefile`, `Dockerfile`, `LICENSE`) are not detected as standalone names to avoid false positives. They are detected when shown with a path (`src/Makefile`) or as part of git status output.
- Only one file path is detected per terminal line.

## Contributing

Found a bug? Have an idea for a useful action? [Open an issue](https://github.com/julien-/terminal-file-actions/issues) or submit a pull request. All suggestions are welcome!

## License

MIT
