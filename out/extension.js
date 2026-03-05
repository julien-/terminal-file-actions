"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;

const vscode = require("vscode");
const fs = require("fs");
const nodePath = require("path");

// ═════════════════════════════════════════════════════════════════════
//  FILE VALIDATION
// ═════════════════════════════════════════════════════════════════════

const SOURCE_EXTS = new Set([
    "js","jsx","ts","tsx","mjs","cjs","mts","cts","vue","svelte","astro",
    "html","htm","css","scss","sass","less","styl",
    "py","pyw","pyi","rb","php","java","kt","kts","scala","go","rs",
    "c","cpp","cc","cxx","h","hpp","hxx","cs","fs","fsx","fsi",
    "swift","m","mm","r","pl","pm","t","ex","exs",
    "hs","lhs","ml","mli","elm","clj","cljs","cljc","erl","hrl",
    "lua","dart","nim","zig","v","d","jl","cr","rkt",
    "sh","bash","zsh","fish","ps1","psm1","bat","cmd",
    "json","jsonc","json5","jsonl","ndjson",
    "yaml","yml","toml","xml","ini","cfg","conf","env","properties","plist",
    "csv","tsv","sql","graphql","gql","prisma","proto",
    "md","mdx","txt","rst","tex","adoc","org",
    "gradle","cmake","mk",
    "tf","tfvars","hcl",
    "lock","map","svg","png","jpg","jpeg","gif","ico","webp","avif",
    "woff","woff2","ttf","eot","otf",
    "pdf","zip","tar","gz","bz2","xz","7z",
    "wasm","so","dylib","dll","a","lib",
    "log","pid","sock","patch","diff",
    "twig","blade","erb","ejs","hbs","pug","njk","liquid",
    "snap","test","spec",
]);

const KNOWN_DOTFILES = new Set([
    ".gitignore",".gitmodules",".gitattributes",".gitkeep",
    ".dockerignore",".editorconfig",
    ".eslintrc",".eslintignore",".prettierrc",".prettierignore",
    ".babelrc",".npmrc",".nvmrc",".yarnrc",
    ".env",".env.local",".env.development",".env.production",".env.test",
    ".htaccess",".browserslistrc",".stylelintrc",
    ".flake8",".pylintrc",".rubocop.yml",
    ".clang-format",".clang-tidy",
]);

const KNOWN_EXTENSIONLESS = new Set([
    "Makefile","GNUmakefile","Dockerfile","Containerfile",
    "Vagrantfile","Gemfile","Rakefile","Procfile","Brewfile",
    "Guardfile","Berksfile","Thorfile","Fastfile","Appfile",
    "Podfile","Dangerfile","Steepfile","Earthfile",
    "LICENSE","LICENCE","CHANGELOG","README","CONTRIBUTING",
    "AUTHORS","CODEOWNERS","OWNERS","COPYING",
    "Makefile.am","Makefile.in","configure",
    "justfile","Taskfile","Snakefile",
]);

// Cached file existence
const _existsCache = new Map();
const CACHE_TTL = 5000;

function cachedFileExists(fullPath) {
    const cached = _existsCache.get(fullPath);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.ok;
    let ok = false;
    try { ok = fs.existsSync(fullPath); } catch {}
    _existsCache.set(fullPath, { ok, ts: Date.now() });
    return ok;
}

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders[0] ? folders[0].uri.fsPath : null;
}

function isKnownFile(basename) {
    if (KNOWN_DOTFILES.has(basename)) return true;
    if (KNOWN_EXTENSIONLESS.has(basename)) return true;
    const dot = basename.lastIndexOf(".");
    if (dot > 0) {
        const ext = basename.substring(dot + 1).toLowerCase();
        return SOURCE_EXTS.has(ext);
    }
    return false;
}

function fileExistsInWorkspace(relPath) {
    const root = getWorkspaceRoot();
    if (!root) return false;
    return cachedFileExists(nodePath.resolve(root, relPath));
}

// ═════════════════════════════════════════════════════════════════════
//  LINE DETECTION — returns array of { filePath, startIndex, length }
// ═════════════════════════════════════════════════════════════════════

// Git verbose status: tab + keyword + colon + spaces + path
const RE_GIT_VERBOSE = /^\t(modified|new file|deleted|renamed|copied|typechange|both modified|both added|both deleted):\s+(.+?)\s*$/;

// Git short status: XY + space(s) + path [-> newpath]
const RE_GIT_SHORT = /^([MADRCUT?!][MADRCUT?! ]|[?!]{2})\s+(.+?)(?:\s+->\s+(.+?))?\s*$/;

// Diff headers
const RE_DIFF_GIT = /^diff --git a\/(.+?) b\/(.+?)\s*$/;
const RE_DIFF_MINUS = /^--- a\/(.+?)\s*$/;
const RE_DIFF_PLUS = /^\+\+\+ b\/(.+?)\s*$/;

// Compiler/linter error: path/file.ext:line[:col]
const RE_COMPILER = /(?:^|\s)((?:\.\.?\/)?(?:[A-Za-z0-9_@.+-]+\/)+[A-Za-z0-9_@.+-]+\.[a-zA-Z0-9]{1,10}):(\d+)(?::(\d+))?/;

// Explicit relative path: ./something or ../something
const RE_RELATIVE = /(?:^|\s)(\.\.?\/(?:[A-Za-z0-9_@.+-]+\/)*[A-Za-z0-9_@.+-]+(?:\.[a-zA-Z0-9]{1,10})?)(?=\s|$|:|,|;|\)|'|"|`)/;

// Path with directory separator: dir/file.ext (must have extension)
const RE_DIR_FILE = /(?:^|\s)((?:[A-Za-z0-9_@.+-]+\/)+[A-Za-z0-9_@.+-]+\.[a-zA-Z0-9]{1,10})(?=\s|$|:|,|;|\)|'|"|`)/;

function detectFilesInLine(line) {
    const results = [];
    const validateExists = vscode.workspace.getConfiguration("terminalContextMenu").get("validateFileExists", true);

    // ── 1. Git verbose ──────────────────────────────────
    let m = RE_GIT_VERBOSE.exec(line);
    if (m) {
        let fp = m[2].trim();
        if (fp.includes(" -> ")) fp = fp.split(" -> ").pop().trim();
        const idx = line.lastIndexOf(fp);
        if (idx >= 0) results.push({ filePath: fp, startIndex: idx, length: fp.length });
        return results; // git status line: one file per line
    }

    // ── 2. Git short ────────────────────────────────────
    m = RE_GIT_SHORT.exec(line);
    if (m) {
        const fp = (m[3] || m[2]).trim(); // prefer rename target
        const idx = line.lastIndexOf(fp);
        if (idx >= 0) results.push({ filePath: fp, startIndex: idx, length: fp.length });
        return results;
    }

    // ── 3. Diff headers ─────────────────────────────────
    m = RE_DIFF_GIT.exec(line);
    if (m) {
        const fp = m[2].trim();
        const idx = line.indexOf("b/" + fp);
        if (idx >= 0) results.push({ filePath: fp, startIndex: idx + 2, length: fp.length });
        return results;
    }
    m = RE_DIFF_MINUS.exec(line) || RE_DIFF_PLUS.exec(line);
    if (m) {
        const fp = m[1].trim();
        const prefix = line.startsWith("---") ? "a/" : "b/";
        const idx = line.indexOf(prefix + fp);
        if (idx >= 0) results.push({ filePath: fp, startIndex: idx + 2, length: fp.length });
        return results;
    }

    // ── 4. Compiler errors ──────────────────────────────
    m = RE_COMPILER.exec(line);
    if (m) {
        const fp = m[1];
        const basename = nodePath.basename(fp);
        if (isKnownFile(basename)) {
            const idx = line.indexOf(fp, m.index);
            if (idx >= 0) results.push({ filePath: fp, startIndex: idx, length: fp.length });
            return results;
        }
    }

    // ── 5. Explicit relative paths (./  ../) ────────────
    m = RE_RELATIVE.exec(line);
    if (m) {
        const fp = m[1];
        const basename = nodePath.basename(fp);
        const shouldValidate = validateExists && !isKnownFile(basename);
        if (!shouldValidate || fileExistsInWorkspace(fp)) {
            const idx = line.indexOf(fp, m.index);
            if (idx >= 0) results.push({ filePath: fp, startIndex: idx, length: fp.length });
            return results;
        }
    }

    // ── 6. dir/file.ext paths ───────────────────────────
    m = RE_DIR_FILE.exec(line);
    if (m) {
        const fp = m[1];
        const basename = nodePath.basename(fp);
        if (isKnownFile(basename)) {
            if (!validateExists || fileExistsInWorkspace(fp)) {
                const idx = line.indexOf(fp, m.index);
                if (idx >= 0) results.push({ filePath: fp, startIndex: idx, length: fp.length });
            }
        }
    }

    return results;
}

// ═════════════════════════════════════════════════════════════════════
//  TERMINAL LINK PROVIDER
// ═════════════════════════════════════════════════════════════════════

let lastClickedFile = null;

class FileTerminalLinkProvider {
    provideTerminalLinks(context) {
        const detections = detectFilesInLine(context.line);
        return detections.map(d => ({
            startIndex: d.startIndex,
            length: d.length,
            tooltip: `Click for actions on: ${d.filePath}`,
            filePath: d.filePath,
        }));
    }

    async handleTerminalLink(link) {
        lastClickedFile = link.filePath;
        await showActionsQuickPick(link.filePath);
    }
}

// ═════════════════════════════════════════════════════════════════════
//  QUICK PICK (on link click — fallback to this since we can't
//  programmatically trigger a native context menu)
// ═════════════════════════════════════════════════════════════════════

async function showActionsQuickPick(filePath) {
    const items = [
        { label: "$(git-commit)  git add",                  _action: "gitAdd" },
        { label: "$(diff)  git diff",                       _action: "gitDiff" },
        { label: "$(discard)  git checkout (discard)",      _action: "gitCheckout" },
        { label: "$(history)  git reset (unstage)",         _action: "gitReset" },
        { label: "$(trash)  git rm",                        _action: "gitRm" },
        { kind: vscode.QuickPickItemKind.Separator, label: "" },
        { label: "$(file)  Open in Editor",                 _action: "openFile" },
        { kind: vscode.QuickPickItemKind.Separator, label: "" },
        { label: "$(copy)  Copy Path",                      _action: "copyPath" },
        { label: "$(folder)  Copy Directory",               _action: "copyDir" },
        { label: "$(tag)  Copy Filename",                   _action: "copyName" },
        { kind: vscode.QuickPickItemKind.Separator, label: "" },
        { label: "$(file-directory)  Reveal in Explorer",   _action: "revealFile" },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: filePath,
    });
    if (!picked) return;

    await executeAction(picked._action, filePath);
}

// ═════════════════════════════════════════════════════════════════════
//  ACTION EXECUTOR (shared by QuickPick and context menu commands)
// ═════════════════════════════════════════════════════════════════════

async function executeAction(action, filePath) {
    const terminal = vscode.window.activeTerminal;
    const root = getWorkspaceRoot() || "";

    switch (action) {
        case "gitAdd":
            terminal && terminal.sendText(`git add "${filePath}"`);
            break;
        case "gitDiff":
            terminal && terminal.sendText(`git diff -- "${filePath}"`);
            break;
        case "gitCheckout":
            terminal && terminal.sendText(`git checkout -- "${filePath}"`);
            break;
        case "gitReset":
            terminal && terminal.sendText(`git reset HEAD -- "${filePath}"`);
            break;
        case "gitRm":
            terminal && terminal.sendText(`git rm "${filePath}"`);
            break;
        case "openFile": {
            const uri = root
                ? vscode.Uri.joinPath(vscode.Uri.file(root), filePath)
                : vscode.Uri.file(filePath);
            try { await vscode.window.showTextDocument(uri); }
            catch { vscode.window.showErrorMessage(`Cannot open: ${filePath}`); }
            break;
        }
        case "copyPath": {
            const full = root ? nodePath.join(root, filePath) : filePath;
            await vscode.env.clipboard.writeText(full);
            vscode.window.setStatusBarMessage(`Copied: ${full}`, 3000);
            break;
        }
        case "copyDir": {
            const dir = nodePath.dirname(filePath);
            const full = root ? nodePath.join(root, dir) : dir;
            await vscode.env.clipboard.writeText(full);
            vscode.window.setStatusBarMessage(`Copied: ${full}`, 3000);
            break;
        }
        case "copyName": {
            const name = nodePath.basename(filePath);
            await vscode.env.clipboard.writeText(name);
            vscode.window.setStatusBarMessage(`Copied: ${name}`, 3000);
            break;
        }
        case "revealFile": {
            const uri = root
                ? vscode.Uri.joinPath(vscode.Uri.file(root), filePath)
                : vscode.Uri.file(filePath);
            await vscode.commands.executeCommand("revealInExplorer", uri);
            break;
        }
    }
}

// ═════════════════════════════════════════════════════════════════════
//  RESOLVE FILE FOR CONTEXT MENU COMMANDS
//  Priority: terminal selection → last clicked link → ask user
// ═════════════════════════════════════════════════════════════════════

async function getTerminalSelection() {
    try {
        const saved = await vscode.env.clipboard.readText();
        await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
        const current = await vscode.env.clipboard.readText();
        // Restore clipboard if it changed
        if (current !== saved) {
            await vscode.env.clipboard.writeText(saved);
            return current.trim();
        }
        return null; // no selection
    } catch {
        return null;
    }
}

function extractFileFromText(text) {
    if (!text) return null;
    let cleaned = text.trim();
    if (cleaned.includes("\n")) return null; // multi-line selection, ignore

    // Strip git status prefixes
    let m;
    if ((m = cleaned.match(/^\t?(?:modified|new file|deleted|renamed|copied|typechange|both modified|both added|both deleted):\s+(.+)/i))) {
        cleaned = m[1].trim();
    } else if ((m = cleaned.match(/^[MADRCUT?! ]{1,2}\s+(.+)/))) {
        cleaned = m[1].trim();
    }

    // Rename arrows
    if (cleaned.includes(" -> ")) {
        cleaned = cleaned.split(" -> ").pop().trim();
    }

    // Strip quotes
    cleaned = cleaned.replace(/^["'](.+)["']$/, "$1");

    // Strip trailing colon + line numbers (compiler errors)
    cleaned = cleaned.replace(/:\d+(?::\d+)?:?\s*$/, "");

    if (cleaned.length === 0 || cleaned.length > 500) return null;
    if (/\s/.test(cleaned)) return null;

    return cleaned;
}

async function resolveFileForCommand() {
    // 1. Try terminal selection
    const sel = await getTerminalSelection();
    const fromSel = extractFileFromText(sel);
    if (fromSel) return fromSel;

    // 2. Last clicked link
    if (lastClickedFile) return lastClickedFile;

    // 3. Ask user
    const input = await vscode.window.showInputBox({
        placeHolder: "path/to/file",
        prompt: "No file detected. Enter the file path manually:",
    });
    return input ? input.trim() : null;
}

// ═════════════════════════════════════════════════════════════════════
//  COMMAND REGISTRATION
// ═════════════════════════════════════════════════════════════════════

function registerContextMenuCommands(context) {
    const actions = [
        "gitAdd", "gitDiff", "gitCheckout", "gitReset", "gitRm",
        "openFile", "copyPath", "copyDir", "copyName", "revealFile",
    ];

    for (const action of actions) {
        context.subscriptions.push(
            vscode.commands.registerCommand(`tcm.${action}`, async () => {
                const file = await resolveFileForCommand();
                if (!file) {
                    vscode.window.showWarningMessage("No file path detected. Select a file path in the terminal first.");
                    return;
                }
                lastClickedFile = file; // update for next use
                await executeAction(action, file);
            })
        );
    }
}

// ═════════════════════════════════════════════════════════════════════
//  ACTIVATION
// ═════════════════════════════════════════════════════════════════════

function activate(context) {
    // Terminal link detection
    context.subscriptions.push(
        vscode.window.registerTerminalLinkProvider(new FileTerminalLinkProvider())
    );

    // Right-click context menu commands
    registerContextMenuCommands(context);

    // Clear existence cache periodically
    const interval = setInterval(() => {
        const now = Date.now();
        for (const [key, val] of _existsCache) {
            if (now - val.ts > CACHE_TTL * 2) _existsCache.delete(key);
        }
    }, CACHE_TTL * 4);
    context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

function deactivate() {
    _existsCache.clear();
}
