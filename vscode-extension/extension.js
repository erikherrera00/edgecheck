const vscode = require('vscode');
const cp = require('child_process');

async function getPythonCmd() {
  const cfg = vscode.workspace.getConfiguration("edgecheck");
  const userPath = cfg.get("pythonPath");
  if (userPath && userPath.trim().length > 0) return userPath;

  // Try to use Python extension's interpreter if available
  try {
    const pyExt = vscode.extensions.getExtension('ms-python.python');
    if (pyExt) {
      const api = await pyExt.activate();
      if (api && api.environments) {
        const env = await api.environments.getActiveEnvironmentPath();
        if (env && env.path) return env.path;
      }
    }
  } catch (_) { /* ignore */ }

  return 'python3';
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || undefined;
}

function runEdgecheck(filePath, budgetMs) {
  return new Promise(async (resolve) => {
    const pythonCmd = await getPythonCmd();
    const args = ['-m', 'cli.main', filePath, '--format', 'json', '--budget-ms', String(budgetMs)];
    const cwd = workspaceRoot();

    const proc = cp.spawn(pythonCmd, args, { cwd });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        resolve({ ok: true, result: parsed, err });
      } catch (e) {
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
  const lines = [
    `**${f.title || 'Crash'}**  `,
    `**Code:** ${f.code || 'EC999'}  `,
    `**Message:** ${f.message}  `
  ];
  if (f.hint) lines.push(`**Hint:** ${f.hint}  `);
  if (reproArgs) lines.push(`**Repro:** (${reproArgs})  `);
  return lines.join('\n');
}

// Quick-fix suggestions (skip informational/guard findings)
function quickFixesForFinding(f) {
  const sev = (f.severity || '').toLowerCase();
  if (sev === 'info') return []; // skip fixes for intentional guards

  const fixes = [];
  if ((f.code === 'EC001' || (f.message || '').startsWith('ZeroDivisionError')) && f.function) {
    fixes.push({
      title: `Insert zero-guard in ${f.function}()`,
      kind: vscode.CodeActionKind.QuickFix,
      apply: (doc, edit) => {
        const line = Math.max(0, (f.line || 1) - 1);
        const insertLine = line + 1;
        const text = doc.lineAt(insertLine).text;
        const indent = (text.match(/^\s*/)?.[0]) ?? '    ';
        const guard = `${indent}if b == 0:\n${indent}    raise ValueError("denominator cannot be zero")\n`;
        edit.insert(new vscode.Position(insertLine, 0), guard);
      }
    });
  }

  if ((f.code === 'EC002' || (f.message || '').startsWith('IndexError')) && f.function) {
    fixes.push({
      title: `Insert length-guard in ${f.function}()`,
      kind: vscode.CodeActionKind.QuickFix,
      apply: (doc, edit) => {
        const line = Math.max(0, (f.line || 1) - 1);
        const insertLine = line + 1;
        const text = doc.lineAt(insertLine).text;
        const indent = (text.match(/^\s*/)?.[0]) ?? '    ';
        const guard = `${indent}if not b or len(b) <= 100:\n${indent}    raise ValueError("buffer too small for index 100")\n`;
        edit.insert(new vscode.Position(insertLine, 0), guard);
      }
    });
  }
  return fixes;
}

function activate(context) {
  const collection = vscode.languages.createDiagnosticCollection('edgecheck');
  context.subscriptions.push(collection);

  async function analyze(document) {
    if (!document || document.languageId !== 'python') return;

    const cfg = vscode.workspace.getConfiguration("edgecheck");
    const budgetMs = cfg.get("budgetMs") || 200;
    const showInfo = cfg.get("showInfo") || false;

    const filePath = document.fileName;
    const { ok, result } = await runEdgecheck(filePath, budgetMs);
    if (!ok || !result) {
      collection.set(document.uri, []);
      return;
    }

    const findings = result.findings || [];

    // 🔑 This is the INFO filter:
    const filtered = findings.filter(f => showInfo ? true : (String(f.severity).toLowerCase() !== 'info'));

    const diags = filtered.map(f => {
      const line = Math.max(0, (f.line || 1) - 1);
      const start = new vscode.Position(line, f.start_col || 0);
      const end = new vscode.Position(line, f.end_col || 120);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(start, end),
        `[${f.code || 'EC999'}] ${f.title || f.message}`,
        severityToVs(f.severity)
      );
      diagnostic.source = 'edgecheck';
      diagnostic.code = f.code || 'EC999';
      diagnostic._edgeFinding = f;
      return diagnostic;
    });

    collection.set(document.uri, diags);
  }

  // Hover provider
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

  // Quick Fix provider
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
      analyze(doc);
    })
  );

  // Manual run command
  context.subscriptions.push(
    vscode.commands.registerCommand('edgecheck.runFile', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) analyze(editor.document);
    })
  );

  // Event triggers
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => analyze(doc)));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => editor && analyze(editor.document)));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => analyze(doc)));

  // Initial run
  if (vscode.window.activeTextEditor) analyze(vscode.window.activeTextEditor.document);
}

function deactivate() {}
module.exports = { activate, deactivate };
