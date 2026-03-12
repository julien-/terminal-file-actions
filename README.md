# Terminal File Actions

A VS Code / code-server extension that detects file paths in terminal output and provides a quick-pick menu with git & file actions.

![VS Code](https://img.shields.io/badge/VS%20Code-1.70%2B-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

Click on any detected file path in the terminal to open an action menu:

**Git actions**
- `git add` -- Stage file
- `git checkout --` -- Discard changes
- `git diff` -- Show diff in editor (both staged and unstaged)
- `git rm` -- Remove file
- `git reset HEAD` -- Unstage file
- `git stash push` -- Stash a single file

**File actions**
- Open in Editor
- Copy full path / directory / filename
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

## Development

```bash
npm install          # Install dependencies
npm run compile      # Build once
npm run watch        # Build on file changes
```

### Project structure

```
terminal-file-actions/
  src/
    extension.ts          # Detection patterns + action execution
  out/
    extension.js          # Compiled output (gitignored)
  commands.default.json   # Default action menu (user-overridable)
  package.json            # Extension manifest + settings schema
  tsconfig.json
```

## Custom commands

The action menu is fully configurable. The default commands are defined in [`commands.default.json`](commands.default.json).

To override them, add `terminalContextMenu.commands` to your VS Code `settings.json`:

```jsonc
"terminalContextMenu.commands": [
  {
    "label": "git add",
    "icon": "git-commit",
    "detail": "Stage file",
    "command": "git add \"{file}\"",
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
| `icon` | string | [Codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) name (without `$()`). Browse all icons at https://microsoft.github.io/vscode-codicons/dist/codicon.html |
| `detail` | string | Secondary description shown below the label |
| `command` | string | Shell command sent to terminal (supports placeholders) |
| `action` | string | Built-in action (see below) |
| `vscodeCommand` | string | Any VS Code command ID (e.g. `vscode.open`, `editor.action.formatDocument`) |
| `args` | array | Arguments for `vscodeCommand` (string args support placeholders) |
| `group` | string | Group name -- items with the same group are visually grouped |

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

## License

MIT
