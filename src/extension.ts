import * as vscode from 'vscode';
import { execSync } from 'child_process';

/**
 * Detects file paths in terminal output (especially after git status)
 * and provides a Cloud9-style quick pick menu with git actions.
 */

interface GitTerminalLink extends vscode.TerminalLink {
	filePath: string;
}

// Patterns that match git status output lines
const GIT_STATUS_PATTERNS = [
	// "modified:   file.txt", "new file:   file.txt", "deleted:    file.txt", "renamed:    file.txt"
	/(?:modified|new file|deleted|renamed|typechange):\s+(.+)/,
	// Short status: "M  file.txt", "?? file.txt", "A  file.txt", "D  file.txt", "R  file.txt", "AM file.txt"
	/^[MADRCUT?! ]{1,2}\s+(.+)/,
	// "both modified:   file.txt" (merge conflicts)
	/(?:both modified|both added|both deleted):\s+(.+)/,
];

// Also match plain file paths (for diff output, etc.)
const FILE_PATH_PATTERN = /(?:^|\s)((?:\.\/|\.\.\/|\/)?(?:[\w.-]+\/)*[\w.-]+\.[\w.]+)/;

function getWorkspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

class GitTerminalLinkProvider implements vscode.TerminalLinkProvider<GitTerminalLink> {

	provideTerminalLinks(context: vscode.TerminalLinkContext): GitTerminalLink[] {
		const links: GitTerminalLink[] = [];
		const line = context.line;

		for (const pattern of GIT_STATUS_PATTERNS) {
			const match = pattern.exec(line);
			if (match && match[1]) {
				const filePath = match[1].trim();
				// Handle renamed files: "old -> new"
				const actualPath = filePath.includes(' -> ') ? filePath.split(' -> ')[1] : filePath;
				const startIndex = line.indexOf(actualPath);
				if (startIndex >= 0) {
					links.push({
						startIndex,
						length: actualPath.length,
						tooltip: 'Git actions...',
						filePath: actualPath,
					});
				}
				return links; // One match per line is enough
			}
		}

		// Fallback: detect generic file paths
		const fileMatch = FILE_PATH_PATTERN.exec(line);
		if (fileMatch && fileMatch[1]) {
			const filePath = fileMatch[1];
			const startIndex = line.indexOf(filePath);
			if (startIndex >= 0) {
				links.push({
					startIndex,
					length: filePath.length,
					tooltip: 'Git actions...',
					filePath,
				});
			}
		}

		return links;
	}

	async handleTerminalLink(link: GitTerminalLink): Promise<void> {
		const filePath = link.filePath;
		const cwd = getWorkspaceRoot();

		// Build menu sections (separators to mimic Cloud9 grouping)
		const gitActions: vscode.QuickPickItem[] = [
			{ label: '$(git-commit) git add', description: filePath, detail: 'Stage file' },
			{ label: '$(discard) git checkout', description: filePath, detail: 'Discard changes' },
			{ label: '$(diff) git diff', description: filePath, detail: 'Show changes' },
			{ label: '$(trash) git rm', description: filePath, detail: 'Remove file' },
			{ label: '$(history) git reset', description: filePath, detail: 'Unstage file' },
			{ label: '$(git-stash) git stash -- file', description: filePath, detail: 'Stash this file' },
			{ kind: vscode.QuickPickItemKind.Separator, label: '' },
			{ label: '$(file) Open in Editor', description: filePath },
			{ label: '$(copy) Copy Path', description: filePath },
			{ label: '$(folder) Copy Directory', description: filePath },
			{ label: '$(tag) Copy Filename', description: filePath },
			{ kind: vscode.QuickPickItemKind.Separator, label: '' },
			{ label: '$(file-directory) Reveal in Explorer', description: filePath },
		];

		const picked = await vscode.window.showQuickPick(gitActions, {
			placeHolder: `Actions for ${filePath}`,
		});

		if (!picked) {
			return;
		}

		const terminal = vscode.window.activeTerminal;

		switch (picked.label) {
			case '$(git-commit) git add':
				terminal?.sendText(`git add "${filePath}"`);
				break;

			case '$(discard) git checkout':
				terminal?.sendText(`git checkout -- "${filePath}"`);
				break;

			case '$(diff) git diff': {
				// Show diff in editor instead of terminal for better UX
				if (cwd) {
					try {
						const diffOutput = execSync(`git diff -- "${filePath}"`, { cwd, encoding: 'utf-8' });
						if (diffOutput.trim()) {
							const doc = await vscode.workspace.openTextDocument({
								content: diffOutput,
								language: 'diff',
							});
							await vscode.window.showTextDocument(doc, { preview: true });
						} else {
							// Maybe staged?
							const stagedDiff = execSync(`git diff --cached -- "${filePath}"`, { cwd, encoding: 'utf-8' });
							if (stagedDiff.trim()) {
								const doc = await vscode.workspace.openTextDocument({
									content: stagedDiff,
									language: 'diff',
								});
								await vscode.window.showTextDocument(doc, { preview: true });
							} else {
								vscode.window.showInformationMessage('No diff found for this file.');
							}
						}
					} catch {
						terminal?.sendText(`git diff -- "${filePath}"`);
					}
				} else {
					terminal?.sendText(`git diff -- "${filePath}"`);
				}
				break;
			}

			case '$(trash) git rm':
				terminal?.sendText(`git rm "${filePath}"`);
				break;

			case '$(history) git reset':
				terminal?.sendText(`git reset HEAD -- "${filePath}"`);
				break;

			case '$(git-stash) git stash -- file':
				terminal?.sendText(`git stash push -m "stash ${filePath}" -- "${filePath}"`);
				break;

			case '$(file) Open in Editor': {
				const fullPath = cwd ? vscode.Uri.joinPath(vscode.Uri.file(cwd), filePath) : vscode.Uri.file(filePath);
				try {
					await vscode.window.showTextDocument(fullPath);
				} catch {
					vscode.window.showErrorMessage(`Cannot open file: ${filePath}`);
				}
				break;
			}

			case '$(copy) Copy Path': {
				const fullPathStr = cwd ? `${cwd}/${filePath}` : filePath;
				await vscode.env.clipboard.writeText(fullPathStr);
				vscode.window.showInformationMessage(`Copied: ${fullPathStr}`);
				break;
			}

			case '$(folder) Copy Directory': {
				const dir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '.';
				const fullDir = cwd ? `${cwd}/${dir}` : dir;
				await vscode.env.clipboard.writeText(fullDir);
				vscode.window.showInformationMessage(`Copied: ${fullDir}`);
				break;
			}

			case '$(tag) Copy Filename': {
				const name = filePath.includes('/') ? filePath.substring(filePath.lastIndexOf('/') + 1) : filePath;
				await vscode.env.clipboard.writeText(name);
				vscode.window.showInformationMessage(`Copied: ${name}`);
				break;
			}

			case '$(file-directory) Reveal in Explorer': {
				const fullUri = cwd ? vscode.Uri.joinPath(vscode.Uri.file(cwd), filePath) : vscode.Uri.file(filePath);
				await vscode.commands.executeCommand('revealInExplorer', fullUri);
				break;
			}
		}
	}
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.window.registerTerminalLinkProvider(new GitTerminalLinkProvider())
	);
}

export function deactivate() {}
