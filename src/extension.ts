import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

interface CommandDef {
	label: string;
	icon?: string;
	detail?: string;
	command?: string;
	action?: string;
	vscodeCommand?: string;
	args?: unknown[];
	group?: string;
}

interface FilePlaceholders {
	file: string;
	absPath: string;
	dir: string;
	name: string;
	ext: string;
}

function buildPlaceholders(filePath: string, cwd: string | undefined): FilePlaceholders {
	const absPath = cwd ? `${cwd}/${filePath}` : filePath;
	const lastSlash = filePath.lastIndexOf('/');
	const name = lastSlash >= 0 ? filePath.substring(lastSlash + 1) : filePath;
	const dir = lastSlash >= 0 ? filePath.substring(0, lastSlash) : '.';
	const dotIdx = name.lastIndexOf('.');
	const ext = dotIdx > 0 ? name.substring(dotIdx + 1) : '';
	return { file: filePath, absPath, dir, name, ext };
}

function resolvePlaceholders(template: string, p: FilePlaceholders): string {
	return template
		.replace(/\{file\}/g, p.file)
		.replace(/\{absPath\}/g, p.absPath)
		.replace(/\{dir\}/g, p.dir)
		.replace(/\{name\}/g, p.name)
		.replace(/\{ext\}/g, p.ext);
}

interface ProcessedCommand {
	text: string;
	send: boolean;
}

async function processCommand(raw: string): Promise<ProcessedCommand | null> {
	let text = raw;

	// {confirm:message} — show Yes/No dialog, abort if No
	const confirmMatch = text.match(/\{confirm:([^}]+)\}/);
	if (confirmMatch) {
		const answer = await vscode.window.showWarningMessage(confirmMatch[1], 'Yes', 'No');
		if (answer !== 'Yes') { return null; }
		text = text.replace(confirmMatch[0], '');
	}

	// {Enter} at the end — send the command (press Enter)
	const send = text.endsWith('{Enter}');
	if (send) {
		text = text.slice(0, -'{Enter}'.length);
	}

	return { text: text.trim(), send };
}

let cachedDefaultCommands: CommandDef[] | null = null;

function loadCommands(extensionPath: string): CommandDef[] {
	const userCommands = vscode.workspace.getConfiguration('terminalContextMenu').get<CommandDef[] | null>('commands');
	if (userCommands && userCommands.length > 0) {
		return userCommands;
	}
	if (!cachedDefaultCommands) {
		const defaultPath = path.join(extensionPath, 'commands.default.json');
		cachedDefaultCommands = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
	}
	return cachedDefaultCommands!;
}

/**
 * Detects file paths in terminal output (especially after git status)
 * and provides a Cloud9-style quick pick menu with git actions.
 */

interface GitTerminalLink extends vscode.TerminalLink {
	filePath: string;
}

interface PatternDef {
	pattern: RegExp;
	fileGroup: number;
}

// Git status output patterns (highest priority)
const GIT_STATUS_PATTERNS: PatternDef[] = [
	// Long format: "modified:   file.txt", "new file:   file.txt", etc.
	{ pattern: /(?:modified|new file|deleted|renamed|typechange):\s+(.+)/, fileGroup: 1 },
	// Merge conflicts
	{ pattern: /(?:both modified|both added|both deleted):\s+(.+)/, fileGroup: 1 },
	// Short format (exactly 2-char prefix): " M file", "?? file", "AM file", "!! file"
	{ pattern: /^([MADRCTU?! ][MADRCTU?! ])\s(.+)/, fileGroup: 2 },
];

// Patterns for specific command outputs
const OUTPUT_PATTERNS: PatternDef[] = [
	// diff --git a/path b/path
	{ pattern: /^diff --git a\/(\S+)\s+b\//, fileGroup: 1 },
	// --- a/path or +++ b/path
	{ pattern: /^[-+]{3} [ab]\/(.+)/, fileGroup: 1 },
	// diff --stat: " src/file.ts   | 5 +++--"
	{ pattern: /^\s+(\S.*?)\s+\|\s+\d+/, fileGroup: 1 },
];

// General file path patterns (fallback, tried in order)
const GENERAL_PATH_PATTERNS: RegExp[] = [
	// Path with at least one directory separator (strong signal, even without extension)
	/(?:^|[\s"'`(])((?:\.\.?\/)?[\w@.+-]+(?:\/[\w@.+-]+)+)/,
	// Dotfile: .gitignore, .env, .eslintrc.json, .dockerignore (at least 2 chars after dot)
	/(?:^|[\s"'`(])(\.[\w][\w.-]+)/,
	// File with extension: file.txt, my-component.test.ts, archive.tar.gz
	/(?:^|[\s"'`(])([\w][\w.-]*\.[\w][\w.]*)/,
];

function getWorkspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

class GitTerminalLinkProvider implements vscode.TerminalLinkProvider<GitTerminalLink> {

	provideTerminalLinks(context: vscode.TerminalLinkContext): GitTerminalLink[] {
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

		// 3. Fallback: general file path detection (only if file exists on disk)
		for (const pattern of GENERAL_PATH_PATTERNS) {
			const m = pattern.exec(line);
			if (m && m[1]) {
				const link = this.makeLink(rawLine, line, m[1], true);
				if (link) { return [link]; }
			}
		}

		return [];
	}

	private makeLink(rawLine: string, cleanLine: string, rawPath: string, checkExists = false): GitTerminalLink | null {
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
		if (filePath.length < 2) { return null; }

		// Skip URLs (http://, https://, ftp://, etc.)
		if (/^https?:\/\/|^ftp:\/\//i.test(filePath)) { return null; }
		// Also skip if the match is part of a URL in the original line
		const posInClean = cleanLine.indexOf(filePath);
		if (posInClean > 0) {
			const before = cleanLine.substring(Math.max(0, posInClean - 10), posInClean);
			if (/https?:\/\/\S*$|ftp:\/\/\S*$/i.test(before)) { return null; }
		}

		// For general/fallback patterns, only link if the file actually exists
		if (checkExists) {
			const cwd = getWorkspaceRoot();
			if (cwd) {
				const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
				if (!fs.existsSync(absPath)) { return null; }
			}
		}

		// Find position in the original raw line for correct underlining
		const startIndex = rawLine.indexOf(filePath);
		if (startIndex < 0) { return null; }

		return {
			startIndex,
			length: filePath.length,
			tooltip: 'Git actions...',
			filePath,
		};
	}

	async handleTerminalLink(link: GitTerminalLink): Promise<void> {
		const filePath = link.filePath;
		const cwd = getWorkspaceRoot();
		const commands = loadCommands(this.extensionPath);

		// Build quick pick items with group separators
		const items: (vscode.QuickPickItem & { _idx?: number })[] = [];
		let lastGroup: string | undefined;

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

		if (!picked || picked._idx === undefined) { return; }

		const chosen = commands[picked._idx];
		const terminal = vscode.window.activeTerminal;
		const p = buildPlaceholders(filePath, cwd);

		// 1. Shell command with placeholders
		if (chosen.command) {
			const resolved = resolvePlaceholders(chosen.command, p);
			const processed = await processCommand(resolved);
			if (!processed) { return; }
			terminal?.sendText(processed.text, processed.send);
			return;
		}

		// 2. VS Code command
		if (chosen.vscodeCommand) {
			const resolvedArgs = (chosen.args || []).map(arg =>
				typeof arg === 'string' ? resolvePlaceholders(arg, p) : arg
			);
			await vscode.commands.executeCommand(chosen.vscodeCommand, ...resolvedArgs);
			return;
		}

		// 3. Built-in action
		switch (chosen.action) {
			case 'diff': {
				if (cwd) {
					try {
						let diffOutput = execSync(`git diff -- "${filePath}"`, { cwd, encoding: 'utf-8' });
						if (!diffOutput.trim()) {
							diffOutput = execSync(`git diff --cached -- "${filePath}"`, { cwd, encoding: 'utf-8' });
						}
						if (diffOutput.trim()) {
							const doc = await vscode.workspace.openTextDocument({ content: diffOutput, language: 'diff' });
							await vscode.window.showTextDocument(doc, { preview: true });
						} else {
							vscode.window.showInformationMessage('No diff found for this file.');
						}
					} catch {
						terminal?.sendText(`git diff -- "${filePath}"`);
					}
				} else {
					terminal?.sendText(`git diff -- "${filePath}"`);
				}
				break;
			}
			case 'openFile': {
				const uri = cwd ? vscode.Uri.joinPath(vscode.Uri.file(cwd), filePath) : vscode.Uri.file(filePath);
				try { await vscode.window.showTextDocument(uri); }
				catch { vscode.window.showErrorMessage(`Cannot open file: ${filePath}`); }
				break;
			}
			case 'copyPath': {
				await vscode.env.clipboard.writeText(p.absPath);
				vscode.window.showInformationMessage(`Copied: ${p.absPath}`);
				break;
			}
			case 'copyDir': {
				const fullDir = cwd ? `${cwd}/${p.dir}` : p.dir;
				await vscode.env.clipboard.writeText(fullDir);
				vscode.window.showInformationMessage(`Copied: ${fullDir}`);
				break;
			}
			case 'copyName': {
				await vscode.env.clipboard.writeText(p.name);
				vscode.window.showInformationMessage(`Copied: ${p.name}`);
				break;
			}
			case 'pastePath': {
				terminal?.sendText(p.absPath, false);
				break;
			}
			case 'revealFile': {
				const uri = cwd ? vscode.Uri.joinPath(vscode.Uri.file(cwd), filePath) : vscode.Uri.file(filePath);
				await vscode.commands.executeCommand('revealInExplorer', uri);
				break;
			}
		}
	}

	extensionPath: string = '';
}

export function activate(context: vscode.ExtensionContext) {
	const provider = new GitTerminalLinkProvider();
	provider.extensionPath = context.extensionPath;
	context.subscriptions.push(
		vscode.window.registerTerminalLinkProvider(provider),
		vscode.commands.registerCommand('tcm.editCommands', () => {
			const filePath = path.join(context.extensionPath, 'commands.default.json');
			vscode.window.showTextDocument(vscode.Uri.file(filePath));
		})
	);
}

export function deactivate() {}
