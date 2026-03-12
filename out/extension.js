"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const child_process_1 = require("child_process");
let cachedDefaultCommands = null;
function loadCommands(extensionPath) {
    const userCommands = vscode.workspace.getConfiguration('terminalContextMenu').get('commands');
    if (userCommands && userCommands.length > 0) {
        return userCommands;
    }
    if (!cachedDefaultCommands) {
        const defaultPath = path.join(extensionPath, 'commands.default.json');
        cachedDefaultCommands = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
    }
    return cachedDefaultCommands;
}
// Git status output patterns (highest priority)
const GIT_STATUS_PATTERNS = [
    // Long format: "modified:   file.txt", "new file:   file.txt", etc.
    { pattern: /(?:modified|new file|deleted|renamed|typechange):\s+(.+)/, fileGroup: 1 },
    // Merge conflicts
    { pattern: /(?:both modified|both added|both deleted):\s+(.+)/, fileGroup: 1 },
    // Short format (exactly 2-char prefix): " M file", "?? file", "AM file", "!! file"
    { pattern: /^([MADRCTU?! ][MADRCTU?! ])\s(.+)/, fileGroup: 2 },
];
// Patterns for specific command outputs
const OUTPUT_PATTERNS = [
    // diff --git a/path b/path
    { pattern: /^diff --git a\/(\S+)\s+b\//, fileGroup: 1 },
    // --- a/path or +++ b/path
    { pattern: /^[-+]{3} [ab]\/(.+)/, fileGroup: 1 },
    // diff --stat: " src/file.ts   | 5 +++--"
    { pattern: /^\s+(\S.*?)\s+\|\s+\d+/, fileGroup: 1 },
];
// General file path patterns (fallback, tried in order)
const GENERAL_PATH_PATTERNS = [
    // Path with at least one directory separator (strong signal, even without extension)
    /(?:^|[\s"'`(])((?:\.\.?\/)?[\w@.+-]+(?:\/[\w@.+-]+)+)/,
    // Dotfile: .gitignore, .env, .eslintrc.json, .dockerignore (at least 2 chars after dot)
    /(?:^|[\s"'`(])(\.[\w][\w.-]+)/,
    // File with extension: file.txt, my-component.test.ts, archive.tar.gz
    /(?:^|[\s"'`(])([\w][\w.-]*\.[\w][\w.]*)/,
];
function getWorkspaceRoot() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
class GitTerminalLinkProvider {
    constructor() {
        this.extensionPath = '';
    }
    provideTerminalLinks(context) {
        const rawLine = context.line;
        // Strip ANSI escape codes (git colors, bold, etc.)
        const line = rawLine.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        // Skip empty lines
        if (!line.trim()) {
            return [];
        }
        // 1. Try git status patterns (highest confidence)
        for (const { pattern, fileGroup } of GIT_STATUS_PATTERNS) {
            const m = pattern.exec(line);
            if (m && m[fileGroup]) {
                const link = this.makeLink(rawLine, line, m[fileGroup]);
                return link ? [link] : [];
            }
        }
        // 2. Try specific command output patterns
        for (const { pattern, fileGroup } of OUTPUT_PATTERNS) {
            const m = pattern.exec(line);
            if (m && m[fileGroup]) {
                const link = this.makeLink(rawLine, line, m[fileGroup]);
                return link ? [link] : [];
            }
        }
        // 3. Fallback: general file path detection
        for (const pattern of GENERAL_PATH_PATTERNS) {
            const m = pattern.exec(line);
            if (m && m[1]) {
                const link = this.makeLink(rawLine, line, m[1]);
                if (link) {
                    return [link];
                }
            }
        }
        return [];
    }
    makeLink(rawLine, cleanLine, rawPath) {
        let filePath = rawPath.trim();
        // Handle renames: "old -> new"
        if (filePath.includes(' -> ')) {
            filePath = filePath.split(' -> ')[1].trim();
        }
        // Strip surrounding quotes
        filePath = filePath.replace(/^["']|["']$/g, '');
        // Strip trailing punctuation unlikely to be part of a path
        filePath = filePath.replace(/[,;:)}\]]+$/, '');
        // Strip trailing slash (directories from git status untracked)
        filePath = filePath.replace(/\/+$/, '');
        // Skip if empty or too short
        if (filePath.length < 2) {
            return null;
        }
        // Find position in the original raw line for correct underlining
        const startIndex = rawLine.indexOf(filePath);
        if (startIndex < 0) {
            return null;
        }
        return {
            startIndex,
            length: filePath.length,
            tooltip: 'Git actions...',
            filePath,
        };
    }
    async handleTerminalLink(link) {
        const filePath = link.filePath;
        const cwd = getWorkspaceRoot();
        const commands = loadCommands(this.extensionPath);
        // Build quick pick items with group separators
        const items = [];
        let lastGroup;
        for (let i = 0; i < commands.length; i++) {
            const cmd = commands[i];
            if (cmd.group && cmd.group !== lastGroup && items.length > 0) {
                items.push({ kind: vscode.QuickPickItemKind.Separator, label: '' });
            }
            lastGroup = cmd.group;
            items.push({
                label: cmd.icon ? `$(${cmd.icon}) ${cmd.label}` : cmd.label,
                description: filePath,
                detail: cmd.detail,
                _idx: i,
            });
        }
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `Actions for ${filePath}`,
        });
        if (!picked || picked._idx === undefined) {
            return;
        }
        const chosen = commands[picked._idx];
        const terminal = vscode.window.activeTerminal;
        // Shell command: send to terminal with {file} replaced
        if (chosen.command) {
            const resolved = chosen.command.replace(/\{file\}/g, filePath);
            terminal?.sendText(resolved);
            return;
        }
        // Built-in action
        switch (chosen.action) {
            case 'diff': {
                if (cwd) {
                    try {
                        let diffOutput = (0, child_process_1.execSync)(`git diff -- "${filePath}"`, { cwd, encoding: 'utf-8' });
                        if (!diffOutput.trim()) {
                            diffOutput = (0, child_process_1.execSync)(`git diff --cached -- "${filePath}"`, { cwd, encoding: 'utf-8' });
                        }
                        if (diffOutput.trim()) {
                            const doc = await vscode.workspace.openTextDocument({ content: diffOutput, language: 'diff' });
                            await vscode.window.showTextDocument(doc, { preview: true });
                        }
                        else {
                            vscode.window.showInformationMessage('No diff found for this file.');
                        }
                    }
                    catch {
                        terminal?.sendText(`git diff -- "${filePath}"`);
                    }
                }
                else {
                    terminal?.sendText(`git diff -- "${filePath}"`);
                }
                break;
            }
            case 'openFile': {
                const uri = cwd ? vscode.Uri.joinPath(vscode.Uri.file(cwd), filePath) : vscode.Uri.file(filePath);
                try {
                    await vscode.window.showTextDocument(uri);
                }
                catch {
                    vscode.window.showErrorMessage(`Cannot open file: ${filePath}`);
                }
                break;
            }
            case 'copyPath': {
                const full = cwd ? `${cwd}/${filePath}` : filePath;
                await vscode.env.clipboard.writeText(full);
                vscode.window.showInformationMessage(`Copied: ${full}`);
                break;
            }
            case 'copyDir': {
                const dir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '.';
                const full = cwd ? `${cwd}/${dir}` : dir;
                await vscode.env.clipboard.writeText(full);
                vscode.window.showInformationMessage(`Copied: ${full}`);
                break;
            }
            case 'copyName': {
                const name = filePath.includes('/') ? filePath.substring(filePath.lastIndexOf('/') + 1) : filePath;
                await vscode.env.clipboard.writeText(name);
                vscode.window.showInformationMessage(`Copied: ${name}`);
                break;
            }
            case 'revealFile': {
                const uri = cwd ? vscode.Uri.joinPath(vscode.Uri.file(cwd), filePath) : vscode.Uri.file(filePath);
                await vscode.commands.executeCommand('revealInExplorer', uri);
                break;
            }
        }
    }
}
function activate(context) {
    const provider = new GitTerminalLinkProvider();
    provider.extensionPath = context.extensionPath;
    context.subscriptions.push(vscode.window.registerTerminalLinkProvider(provider), vscode.commands.registerCommand('tcm.editCommands', () => {
        const filePath = path.join(context.extensionPath, 'commands.default.json');
        vscode.window.showTextDocument(vscode.Uri.file(filePath));
    }));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map