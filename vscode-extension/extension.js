// vscode-extension/extension.js
const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

let statusBar; // status bar item (created on activate)

async function getPythonCmd() {
  const cfg = vscode.workspace.getConfiguration("edgecheck");
  const userPath = cfg.get("pythonPath");
  if (userPath && userPath.trim().length > 0) return userPath;
  try {
    const pyExt = vscode.extensions.getExtension('ms-python.python');
    if (pyExt) {
      const api = await pyExt.activate();
      if (api && api.environments) {
        const env = await api.environments.getActiveEnvironmentPath();
        if (env && env.path) return env.path;
      }
    }
  } catch (_) {}
  return 'python3';
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || undefined;
}

function runEdgecheck(filePath, { budgetMs, maxTrials, maxFindings }) {
  return new Promise(async (resolve) => {
    const pythonCmd = await getPythonCmd();
    const args = [
      '-m', 'cli.main', filePath,
      '--format', 'json',
      '--budget-ms', String(budgetMs),
      '--max-trials', String(maxTrials),
      '--max-findings', String(maxFindings)
    ];
    const cwd = workspaceRoot();
    const proc = cp.spawn(pythonCmd, args, { cwd });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        resolve({ ok: true, result: parsed, err });
      } catch (_e) {
        resolve({ ok: false, result: null, err: (err || '') + out });
      }
    });
  });
}

function severityToVs(sev) {
  switch ((sev || 'warning').toLowerCase()) {
    case 'error': return vscode.DiagnosticSeverity.Error;
    case 'info': return vscode.DiagnosticSeverity.Information;
    default: return vscode.DiagnosticSeverity.Warning;
  }
}

function mkHoverText(f) {
  const reproArgs = Array.isArray(f?.repro?.args) ? f.repro.args.join(', ') : '';
  const params = Array.isArray(f?.param_names) ? f.param_names.join(', ') : '';
  const lines = [
    `**${f.title || 'Crash'}**  `,
    `**Code:** ${f.code || 'EC999'}  `,
    `**Message:** ${f.message}  `
  ];
  if (f.hint) lines.push(`**Hint:** ${f.hint}  `);
  if (params) lines.push(`**Params:** (${params})  `);
  if (reproArgs) lines.push(`**Repro:** (${reproArgs})  `);
  return lines.join('\n');
}

// Parameter-aware quick-fixes; skip infos
function quickFixesForFinding(f) {
  const sev = (f.severity || '').toLowerCase();
  if (sev === 'info') return [];

  const params = Array.isArray(f.param_names) ? f.param_names : [];
  const fixes = [];

  // EC001 ZeroDivisionError
  if ((f.code === 'EC001' || (f.message || '').startsWith('ZeroDivisionError')) && f.function) {
    let denom = params[1] || params.find(p => p.toLowerCase() === 'b') || 'b';
    fixes.push({
      title: `Insert zero-guard in ${f.function}()`,
      kind: vscode.CodeActionKind.QuickFix,
      apply: (doc, edit) => {
        const line = Math.max(0, (f.line || 1) - 1);
        const insertLine = line + 1;
        const text = doc.lineAt(insertLine).text;
        const indent = (text.match(/^\s*/)?.[0]) ?? '    ';
        const guard = `${indent}if ${denom} == 0:\n${indent}    raise ValueError("denominator cannot be zero")\n`;
        edit.insert(new vscode.Position(insertLine, 0), guard);
      }
    });
  }

  // EC002 IndexError
  if ((f.code === 'EC002' || (f.message || '').startsWith('IndexError')) && f.function) {
    let buf = params[0] || params.find(p => p.toLowerCase() === 'b') || 'b';
    const m = /index\s+(\d+)/i.exec(f.message || '');
    const idx = m ? m[1] : '0';
    fixes.push({
      title: `Insert length-guard in ${f.function}()`,
      kind: vscode.CodeActionKind.QuickFix,
      apply: (doc, edit) => {
        const line = Math.max(0, (f.line || 1) - 1);
        const insertLine = line + 1;
        const text = doc.lineAt(insertLine).text;
        const indent = (text.match(/^\s*/)?.[0]) ?? '    ';
        const guard = `${indent}if not ${buf} or len(${buf}) <= ${idx}:\n${indent}    raise ValueError("buffer too small for index ${idx}")\n`;
        edit.insert(new vscode.Position(insertLine, 0), guard);
      }
    });
  }

  return fixes;
}

function summarizeDiagnostics(collection) {
  let errors = 0, warnings = 0;
  for (const doc of vscode.workspace.textDocuments) {
    const diags = collection.get(doc.uri) || [];
    diags.forEach(d => {
      if (d.severity === vscode.DiagnosticSeverity.Error) errors += 1;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings += 1;
    });
  }
  return { errors, warnings };
}

function updateStatusBar(collection, label = '') {
  if (!statusBar) return;
  const { errors, warnings } = summarizeDiagnostics(collection);
  const summary = `${errors}E ${warnings}W`;
  statusBar.text = label ? `EdgeCheck: ${summary} — ${label}` : `EdgeCheck: ${summary}`;
  statusBar.tooltip = new vscode.MarkdownString("Click for EdgeCheck menu:\n\n• Scan file\n• Scan workspace\n• Toggle infos\n• Open last SARIF");
  statusBar.command = 'edgecheck.statusMenu';
  statusBar.show();
}

async function showStatusMenu(collection) {
  const cfg = vscode.workspace.getConfiguration('edgecheck');
  const showInfo = !!cfg.get('showInfo');
  const picks = [
    { label: '$(search) Scan current file', cmd: 'edgecheck.runFile' },
    { label: '$(sync) Scan workspace', cmd: 'edgecheck.scanWorkspace' },
    { label: (showInfo ? '$(eye-closed) Hide info diagnostics' : '$(eye) Show info diagnostics'), cmd: 'edgecheck.toggleShowInfo' },
    { label: '$(file) Open last SARIF', cmd: 'edgecheck.openSarif' }
  ];
  const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'EdgeCheck' });
  if (choice) vscode.commands.executeCommand(choice.cmd);
}

function activate(context) {
  const collection = vscode.languages.createDiagnosticCollection('edgecheck');
  context.subscriptions.push(collection);

  // Status bar
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "EdgeCheck ▶︎ Menu";
  statusBar.command = 'edgecheck.statusMenu';
  statusBar.tooltip = new vscode.MarkdownString("Open EdgeCheck menu");
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ===== Core analysis helpers =====
  async function analyzeDocument(document, label = '') {
    if (!document || document.languageId !== 'python') return;
    await analyzePath(document.fileName, document.uri, label);
  }

  async function analyzePath(filePath, uriOverride, labelForStatus = '') {
    const cfg = vscode.workspace.getConfiguration("edgecheck");
    const budgetMs = cfg.get("budgetMs") || 200;
    const showInfo = cfg.get("showInfo") || false;
    const maxTrials = cfg.get("maxTrialsPerFunction") || 24;
    const maxFindings = cfg.get("maxFindingsPerFile") || 50;

    const { ok, result } = await runEdgecheck(filePath, { budgetMs, maxTrials, maxFindings });
    const uri = uriOverride || vscode.Uri.file(filePath);
    if (!ok || !result) {
      collection.set(uri, []);
      updateStatusBar(collection, labelForStatus);
      return;
    }
    const findings = result.findings || [];
    const filtered = findings.filter(f => showInfo ? true : (String(f.severity).toLowerCase() !== 'info'));

    const diags = filtered.map(f => {
      const line = Math.max(0, (f.line || 1) - 1);
      const start = new vscode.Position(line, f.start_col || 0);
      const end = new vscode.Position(line, f.end_col || 120);
      const d = new vscode.Diagnostic(
        new vscode.Range(start, end),
        `[${f.code || 'EC999'}] ${f.title || f.message}`,
        severityToVs(f.severity)
      );
      d.source = 'edgecheck';
      d.code = f.code || 'EC999';
      d._edgeFinding = f;
      return d;
    });
    collection.set(uri, diags);
    updateStatusBar(collection, labelForStatus);
  }

  // ===== Providers =====
  context.subscriptions.push(
    vscode.languages.registerHoverProvider('python', {
      provideHover(doc, pos) {
        const diags = collection.get(doc.uri) || [];
        const match = diags.find(d => d.range.contains(pos));
        if (!match) return;
        const f = match._edgeFinding;
        const md = new vscode.MarkdownString(mkHoverText(f));
        md.isTrusted = false;
        return new vscode.Hover(md);
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      'python',
      {
        provideCodeActions(doc, range) {
          const diags = collection.get(doc.uri) || [];
          const hits = diags.filter(d => d.range.intersection(range));
          const actions = [];
          hits.forEach(d => {
            const f = d._edgeFinding;
            quickFixesForFinding(f).forEach(qf => {
              const action = new vscode.CodeAction(qf.title, qf.kind);
              action.command = {
                title: qf.title,
                command: 'edgecheck.applyFix',
                arguments: [doc.uri, f, qf.title]
              };
              actions.push(action);
            });
          });
          return actions;
        }
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );

  // ===== Commands =====

  // Menu entry (status bar)
  context.subscriptions.push(
    vscode.commands.registerCommand('edgecheck.statusMenu', () => showStatusMenu(collection))
  );

  // Apply quick-fix
  context.subscriptions.push(
    vscode.commands.registerCommand('edgecheck.applyFix', async (uri, finding, title) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      await editor.edit(edit => {
        quickFixesForFinding(finding).forEach(qf => {
          if (qf.title === title) qf.apply(doc, edit);
        });
      });
      analyzeDocument(doc, `fixed ${vscode.workspace.asRelativePath(uri)}`);
    })
  );

  // Analyze current file
  context.subscriptions.push(
    vscode.commands.registerCommand('edgecheck.runFile', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) analyzeDocument(editor.document, `scanned ${vscode.workspace.asRelativePath(editor.document.uri)}`);
    })
  );

  // Scan workspace
  context.subscriptions.push(
    vscode.commands.registerCommand('edgecheck.scanWorkspace', async () => {
      const out = vscode.window.createOutputChannel("EdgeCheck");
      out.clear();
      out.appendLine("Scanning workspace for Python files...");

      const cfg = vscode.workspace.getConfiguration("edgecheck");
      const includeGlobs = cfg.get("scanInclude") || ["**/src/**/*.py", "**/examples/**/*.py"];
      const excludeGlobs = cfg.get("scanExclude") || [
        "**/.venv/**","**/venv/**","**/site-packages/**","**/node_modules/**",
        "**/dist/**","**/build/**","**/__pycache__/**","**/.git/**",
        "**/cli/**","**/core/**","**/workers/**","**/tests/**","**/tools/**"
      ];

      let files = [];
      for (const pattern of includeGlobs) {
        const uris = await vscode.workspace.findFiles(pattern, excludeGlobs.join(','));
        files.push(...uris);
      }
      const seen = new Set();
      files = files.filter(u => (seen.has(u.fsPath) ? false : (seen.add(u.fsPath), true)));

      out.appendLine(`Found ${files.length} files.`);

      const budgetMs = cfg.get("budgetMs") || 200;
      const showInfo = cfg.get("showInfo") || false;
      const maxTrials = cfg.get("maxTrialsPerFunction") || 24;
      const maxFindings = cfg.get("maxFindingsPerFile") || 50;

      let total = 0, errors = 0, warnings = 0;
      for (const uri of files) {
        const { ok, result } = await runEdgecheck(uri.fsPath, { budgetMs, maxTrials, maxFindings });
        if (!ok || !result) {
          collection.set(uri, []);
          continue;
        }
        const findings = (result.findings || []).filter(f => showInfo ? true : (String(f.severity).toLowerCase() !== 'info'));
        total += findings.length;

        const diags = findings.map(f => {
          const line = Math.max(0, (f.line || 1) - 1);
          const start = new vscode.Position(line, f.start_col || 0);
          const end = new vscode.Position(line, f.end_col || 120);
          const d = new vscode.Diagnostic(new vscode.Range(start, end), `[${f.code || 'EC999'}] ${f.title || f.message}`, severityToVs(f.severity));
          d.source = 'edgecheck';
          d.code = f.code || 'EC999';
          d._edgeFinding = f;
          if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
          else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
          return d;
        });
        collection.set(uri, diags);

        if (findings.length) {
          out.appendLine(`${uri.fsPath}`);
          findings.forEach(f => out.appendLine(`  - [${f.code}] ${f.title} @ ${f.line}:${(f.start_col||0)+1}`));
        }
      }
      out.appendLine(`\nDone. Findings: ${total}  (Errors: ${errors}, Warnings: ${warnings})`);
      updateStatusBar(collection, `scan done`);
      out.show(true);
    })
  );

  // Toggle Show Info
  context.subscriptions.push(
    vscode.commands.registerCommand('edgecheck.toggleShowInfo', async () => {
      const cfg = vscode.workspace.getConfiguration('edgecheck');
      const current = !!cfg.get('showInfo');
      await cfg.update('showInfo', !current, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(`EdgeCheck: Show Info is now ${!current ? 'ON' : 'OFF'}.`);
      // Re-analyze active file so the change is visible immediately
      const editor = vscode.window.activeTextEditor;
      if (editor) analyzeDocument(editor.document, `info ${!current ? 'on' : 'off'}`);
    })
  );

  // Open last SARIF
  context.subscriptions.push(
    vscode.commands.registerCommand('edgecheck.openSarif', async () => {
      const root = workspaceRoot();
      if (!root) return;
      const sarifPath = path.join(root, 'edgecheck.sarif');
      if (!fs.existsSync(sarifPath)) {
        vscode.window.showWarningMessage('No edgecheck.sarif found. Run the SARIF task or Scan Workspace first.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sarifPath));
      await vscode.window.showTextDocument(doc, { preview: false });
    })
  );

  // Triggers
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => analyzeDocument(doc, `opened ${vscode.workspace.asRelativePath(doc.uri)}`)));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => editor && analyzeDocument(editor.document, `focused ${vscode.workspace.asRelativePath(editor.document.uri)}`)));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => analyzeDocument(doc, `saved ${vscode.workspace.asRelativePath(doc.uri)}`)));

  if (vscode.window.activeTextEditor) analyzeDocument(vscode.window.activeTextEditor.document, 'startup');
}

function deactivate() {}
module.exports = { activate, deactivate };
