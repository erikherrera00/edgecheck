/* EdgeCheck VS Code extension — bundled-ready, EDU preset, Insert Sample, Fix All confirm */
'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

const CH = vscode.window.createOutputChannel('EdgeCheck');
const diag = vscode.languages.createDiagnosticCollection('EdgeCheck');
const META = new Map(); // key -> finding meta

function log(...args) {
  try {
    const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ');
    CH.appendLine(msg);
  } catch { CH.appendLine(String(args)); }
}
function cfg() { return vscode.workspace.getConfiguration('edgecheck'); }
function repoRoot() {
  const wf = vscode.workspace.workspaceFolders?.[0];
  return wf ? wf.uri.fsPath : process.cwd();
}
function pythonBin() {
  const v = (cfg().get('pythonPath') || '').toString().trim();
  return v || 'python3';
}
function currentIndent(document, line) {
  const text = document.lineAt(line).text;
  const m = text.match(/^\s*/);
  return (m && m[0]) || '';
}
async function lineHasIgnoreComment(absPath, zeroBasedLine, code) {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
    const maxBack = 2;
    for (let i = Math.max(0, zeroBasedLine); i >= Math.max(0, zeroBasedLine - maxBack); i--) {
      const t = doc.lineAt(i).text;
      if (t.includes(`# edgecheck: ignore ${code}`) || t.includes(`# edgecheck:ignore ${code}`)) return true;
    }
  } catch (_) {}
  return false;
}
function countSeverities() {
  let errors = 0, warnings = 0;
  diag.forEach((_uri, ds) => {
    (ds || []).forEach(d => {
      if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
    });
  });
  return { errors, warnings };
}
let statusLeft;
function ensureStatus() {
  if (!statusLeft) {
    statusLeft = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusLeft.command = 'edgecheck.runFile';
    statusLeft.tooltip = 'EdgeCheck: Scan Current File';
  }
  const { errors, warnings } = countSeverities();
  statusLeft.text = (errors + warnings) > 0
    ? `$(shield) EdgeCheck: ${errors} errors • ${warnings} warn`
    : '$(shield) EdgeCheck: Ready';
  statusLeft.show();
}

/* ---------------- CLI bridge ---------------- */
function runCliForFile(filePath) {
  return new Promise((resolve) => {
    const py = pythonBin();
    const cwd = repoRoot();
    const args = ['-m', 'cli.main', filePath, '--format', 'json'];
    CH.show(true);
    log(`$ ${py} ${args.join(' ')}`);
    const ps = cp.spawn(py, args, { cwd, shell: false });
    let out = '', err = '';
    ps.stdout.on('data', d => (out += d.toString()));
    ps.stderr.on('data', d => (err += d.toString()));
    ps.on('close', (code) => {
      if (err.trim()) log(err.trim());
      try { resolve(JSON.parse(out)); }
      catch (e) {
        log(`JSON parse error or non-zero exit (${code}): ${e}`);
        resolve({ version: '0.1.0', findings: [] });
      }
    });
  });
}
function runCliForWorkspace() {
  return new Promise((resolve) => {
    const py = pythonBin();
    const cwd = repoRoot();
    const args = ['-m', 'cli.main', '.', '--format', 'json'];
    CH.show(true);
    log(`$ ${py} ${args.join(' ')}`);
    const ps = cp.spawn(py, args, { cwd, shell: false });
    let out = '', err = '';
    ps.stdout.on('data', d => (out += d.toString()));
    ps.stderr.on('data', d => (err += d.toString()));
    ps.on('close', (code) => {
      if (err.trim()) log(err.trim());
      try { resolve(JSON.parse(out)); }
      catch (e) {
        log(`JSON parse error or non-zero exit (${code}): ${e}`);
        resolve({ version: '0.1.0', findings: [] });
      }
    });
  });
}

/* ---------------- Publish diagnostics (clear + coalesce) ---------------- */
async function publishFindings(findings) {
  diag.clear();
  META.clear();

  const hideTimeouts = !!cfg().get('hideTimeouts');
  const doCoalesce   = !!cfg().get('coalesceOverlapping');

  const byFile = new Map();
  for (const f of findings || []) {
    if (!f || !f.file) continue;
    const isTimeout = /timeout/i.test(f.title || '') || /timeout/i.test(f.message || '');
    if (hideTimeouts && isTimeout) continue;
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  for (const [file, items] of byFile) {
    const abs  = path.isAbsolute(file) ? file : path.join(repoRoot(), file);
    const norm = path.normalize(abs);
    const uri  = vscode.Uri.file(norm);

    const exactKey = (it) => [
      it.line || 1,
      it.start_col || 0,
      it.end_col || (it.start_col || 0) + 1,
      it.code || 'EC999',
      it.message || it.title || ''
    ].join(':');

    const seen = new Set();
    const normalized = [];
    for (const it of items) {
      const key = exactKey(it);
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({
        ...it,
        line: Math.max(1, it.line || 1),
        start_col: Math.max(0, it.start_col || 0),
        end_col: Math.max((it.start_col || 0) + 1, it.end_col || ((it.start_col || 0) + 1)),
        severity: String(it.severity || 'warning').toLowerCase()
      });
    }

    let coalesced = normalized;
    if (doCoalesce) {
      const groups = new Map();
      for (const it of normalized) {
        const key = `${it.line}:${it.severity}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it);
      }

      coalesced = [];
      for (const arr of groups.values()) {
        arr.sort((a, b) => a.start_col - b.start_col);
        let curr = null;
        for (const it of arr) {
          if (!curr) { curr = seed(it); continue; }
          const overlaps = it.start_col <= curr.end_col + 1;
          if (overlaps) {
            curr.end_col = Math.max(curr.end_col, it.end_col);
            curr._msgs.push(msg(it));
            curr._codes.add(it.code || 'EC999');
          } else {
            coalesced.push(fin(curr));
            curr = seed(it);
          }
        }
        if (curr) coalesced.push(fin(curr));
      }
    }

    const ds = [];
    for (const it of coalesced) {
      const line0 = it.line - 1;
      if (await lineHasIgnoreComment(norm, line0, it.code || 'EC999')) continue;

      const range = new vscode.Range(line0, it.start_col, line0, it.end_col);
      const sev =
        it.severity === 'error' ? vscode.DiagnosticSeverity.Error :
        it.severity === 'info'  ? vscode.DiagnosticSeverity.Information :
        it.severity === 'hint'  ? vscode.DiagnosticSeverity.Hint :
                                  vscode.DiagnosticSeverity.Warning;

      const message = it._mergedMessage || it.message || it.title || 'EdgeCheck finding';
      const d = new vscode.Diagnostic(range, message, sev);
      d.source = 'EdgeCheck';
      d.code = { value: it._mergedCode || it.code || 'EC999' };

      META.set(`${norm}:${line0}:${it.start_col}:${it.end_col}`, it);
      ds.push(d);
    }

    diag.set(uri, ds);
  }

  ensureStatus();

  function seed(it) { return { ...it, _msgs: [msg(it)], _codes: new Set([it.code || 'EC999']) }; }
  function fin(o) {
    const mergedMsg = Array.from(new Set(o._msgs)).join(' • ');
    const mergedCode = Array.from(o._codes).join(',');
    return { ...o, _mergedMessage: mergedMsg, _mergedCode: mergedCode };
  }
  function msg(it) { return (it.message || it.title || '').trim(); }
}

/* ---------------- Quick Fix provider ---------------- */
function metaForDiagnostic(document, d) {
  return META.get(`${document.uri.fsPath}:${d.range.start.line}:${d.range.start.character}:${d.range.end.character}`);
}

class EdgeCheckQuickFixProvider {
  provideCodeActions(document, range) {
    const actions = [];
    const own = diag.get(document.uri) || [];

    const caret = range || new vscode.Range(0, 0, 0, 0);
    const caretLine = Math.max(0, caret.start.line);
    const nearbyN = Math.max(0, Number(cfg().get('quickFix.nearbyLines') || 2));
    let candidates = own.filter(d => !!d.range.intersection(caret));
    if (!candidates.length) {
      candidates = own.filter(d => Math.abs(d.range.start.line - caretLine) <= nearbyN);
    }

    for (const d of candidates) {
      const codeVal = typeof d.code === 'object' && d.code ? d.code.value : d.code;
      const codeStr = String(codeVal || '');
      const m = metaForDiagnostic(document, d) || {};
      const func = m.function || '(function)';
      const atLine = d.range.start.line;
      const indent = currentIndent(document, atLine);

      if (codeStr.includes('EC001')) {
        const title = `EdgeCheck: add zero-denominator guard in ${func}`;
        const fix = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        fix.isPreferred = true;
        fix.diagnostics = [d];
        const e = new vscode.WorkspaceEdit();
        const msg = (cfg().get('zeroGuardMessage') || 'denominator cannot be zero').toString();
        e.insert(document.uri, new vscode.Position(atLine, 0),
          `${indent}if b == 0:\n${indent}    raise ValueError("${msg}")\n`);
        fix.edit = e;
        actions.push(fix);
      }

      if (codeStr.includes('EC002')) {
        const title = `EdgeCheck: add bounds/type guard in ${func}`;
        const fix = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        fix.diagnostics = [d];
        const e = new vscode.WorkspaceEdit();
        e.insert(document.uri, new vscode.Position(atLine, 0), [
          `${indent}if not isinstance(b, (bytes, bytearray)):`,
          `${indent}    raise TypeError("b must be bytes-like")`,
          `${indent}if len(b) <= 100:`,
          `${indent}    raise ValueError("buffer too small for index 100")`,
          ''
        ].join('\n'));
        fix.edit = e;
        actions.push(fix);
      }

      if (codeStr) {
        const sup = new vscode.CodeAction(`EdgeCheck: suppress ${codeStr} in ${func}`, vscode.CodeActionKind.QuickFix);
        sup.diagnostics = [d];
        const e2 = new vscode.WorkspaceEdit();
        e2.insert(document.uri, new vscode.Position(atLine, 0), `${indent}# edgecheck: ignore ${codeStr}\n`);
        sup.edit = e2;
        actions.push(sup);
      }
    }

    // Safety no-op to always show a bulb
    const testFix = new vscode.CodeAction('EdgeCheck: Test Quick Fix (insert comment)', vscode.CodeActionKind.QuickFix);
    const te = new vscode.WorkspaceEdit();
    te.insert(document.uri, new vscode.Position(Math.max(0, (range?.start.line || 0)), 0), '# edgecheck: test quick fix\n');
    testFix.edit = te;
    actions.push(testFix);

    return actions;
  }
}

/* ---------------- Commands ---------------- */
async function runCurrentFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return vscode.window.showWarningMessage('EdgeCheck: open a Python file first.');
  const doc = editor.document;
  if (doc.uri.scheme !== 'file' || doc.languageId !== 'python') {
    return vscode.window.showWarningMessage('EdgeCheck: focus a real .py file.');
  }
  await doc.save();

  const res = await runCliForFile(doc.fileName);
  const findings = res.findings || [];
  log(`findings for ${doc.fileName}: ${findings.length}`);
  await publishFindings(findings);

  const ds = diag.get(doc.uri) || [];
  ensureStatus();
  if (ds.length) {
    editor.revealRange(ds[0].range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(ds[0].range.start, ds[0].range.start);
  }
}

async function scanWorkspace() {
  const res = await runCliForWorkspace();
  await publishFindings(res.findings || []);
}

async function fixAllInCurrentFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'python' || editor.document.uri.scheme !== 'file') {
    return vscode.window.showWarningMessage('EdgeCheck: open a real .py file.');
  }

  const ans = await vscode.window.showWarningMessage(
    'Apply guards for all EdgeCheck findings in this file?', { modal: true }, 'Apply'
  );
  if (ans !== 'Apply') return;

  await runCurrentFile();

  const doc = editor.document;
  const ds = (diag.get(doc.uri) || []).slice().sort((a, b) => a.range.start.line - b.range.start.line);
  if (!ds.length) {
    vscode.window.showInformationMessage('EdgeCheck: no diagnostics to fix in this file.');
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  const zeroMsg = (cfg().get('zeroGuardMessage') || 'denominator cannot be zero').toString();
  const insertedAt = new Set();

  for (const d of ds) {
    const codeVal = typeof d.code === 'object' && d.code ? d.code.value : d.code;
    const codeStr = String(codeVal || '');
    const line = d.range.start.line;
    const key = `${line}:${d.range.start.character}`;
    const indent = currentIndent(doc, line);

    if (codeStr.includes('EC001')) {
      if (!insertedAt.has(key)) {
        edit.insert(doc.uri, new vscode.Position(line, 0),
          `${indent}if b == 0:\n${indent}    raise ValueError("${zeroMsg}")\n`);
        insertedAt.add(key);
      }
    } else if (codeStr.includes('EC002')) {
      if (!insertedAt.has(key)) {
        edit.insert(doc.uri, new vscode.Position(line, 0), [
          `${indent}if not isinstance(b, (bytes, bytearray)):`,
          `${indent}    raise TypeError("b must be bytes-like")`,
          `${indent}if len(b) <= 100:`,
          `${indent}    raise ValueError("buffer too small for index 100")`,
          ''
        ].join('\n'));
        insertedAt.add(key);
      }
    }
  }

  if (insertedAt.size === 0) {
    vscode.window.showInformationMessage('EdgeCheck: nothing applicable to fix automatically.');
    return;
  }

  const ok = await vscode.workspace.applyEdit(edit);
  if (ok) {
    await doc.save();
    vscode.window.showInformationMessage(`EdgeCheck: applied ${insertedAt.size} guard${insertedAt.size === 1 ? '' : 's'}.`);
    await runCurrentFile();
  } else {
    vscode.window.showWarningMessage('EdgeCheck: could not apply edits.');
  }
}

/* EDU preset: calm defaults for classrooms */
async function applyEduPreset() {
  const c = vscode.workspace.getConfiguration('edgecheck');
  await c.update('autoScanOnSave', true, vscode.ConfigurationTarget.Workspace);
  await c.update('hideTimeouts', true, vscode.ConfigurationTarget.Workspace);
  await c.update('coalesceOverlapping', true, vscode.ConfigurationTarget.Workspace);
  await c.update('quickFix.nearbyLines', 4, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage('EdgeCheck: EDU preset applied to this workspace.');
}

/* Insert sample snippet */
async function insertSampleSnippet() {
  const tpl = [
    'def divide(a: int, b: int):',
    '    return a / b  # risk: ZeroDivisionError',
    '',
    'def bad_bytes(b: bytes):',
    '    return b[100]  # risk: IndexError',
    ''
  ].join('\n');

  const doc = await vscode.workspace.openTextDocument({ language: 'python', content: tpl });
  await vscode.window.showTextDocument(doc, { preview: false });
  vscode.window.showInformationMessage('EdgeCheck sample inserted. Run: EdgeCheck: Scan Current File.');
}

/* Debug helpers */
function showOutput() { CH.show(true); }
function clearAllDiagnostics() { diag.clear(); META.clear(); CH.appendLine('[edgecheck] cleared all diagnostics'); ensureStatus(); }
function focusProblemsView() { vscode.commands.executeCommand('workbench.actions.view.problems'); }
async function resetProblemsFilters() {
  await vscode.commands.executeCommand('problems.action.clearFilter');
  await vscode.commands.executeCommand('problems.action.toggleActiveFileFilter');
  await vscode.commands.executeCommand('problems.action.toggleActiveFileFilter');
  await vscode.commands.executeCommand('workbench.actions.view.problems');
  vscode.window.showInformationMessage('EdgeCheck: Problems filters reset. Ensure Errors/Warnings/Info are enabled in the funnel menu.');
}
function dumpDiagnosticsToOutput() {
  CH.show(true);
  CH.appendLine('--- EdgeCheck Diagnostics Dump ---');
  let total = 0;
  diag.forEach((uri, ds) => {
    (ds || []).forEach(d => {
      total++;
      const sev =
        d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' :
        d.severity === vscode.DiagnosticSeverity.Warning ? 'WARN' :
        d.severity === vscode.DiagnosticSeverity.Information ? 'INFO' : 'HINT';
      const code = (typeof d.code === 'object' && d.code) ? (d.code.value || '') : (d.code || '');
      CH.appendLine(`[${sev}] ${uri.fsPath}:${d.range.start.line + 1}:${d.range.start.character + 1} ${code} ${d.message}`);
    });
  });
  CH.appendLine(`--- total: ${total} ---`);
}

/* ---------------- Activate / Deactivate ---------------- */
function activate(context) {
  CH.show(true);
  log('EdgeCheck activated.');

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: 'python' },
      new EdgeCheckQuickFixProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),

    vscode.commands.registerCommand('edgecheck.runFile', runCurrentFile),
    vscode.commands.registerCommand('edgecheck.scanWorkspace', scanWorkspace),
    vscode.commands.registerCommand('edgecheck.fixAllInCurrentFile', fixAllInCurrentFile),

    vscode.commands.registerCommand('edgecheck.applyEduPreset', applyEduPreset),
    vscode.commands.registerCommand('edgecheck.insertSample', insertSampleSnippet),

    vscode.commands.registerCommand('edgecheck.showOutput', showOutput),
    vscode.commands.registerCommand('edgecheck.clearDiagnostics', clearAllDiagnostics),
    vscode.commands.registerCommand('edgecheck.focusProblems', focusProblemsView),
    vscode.commands.registerCommand('edgecheck.resetProblemsFilters', resetProblemsFilters),
    vscode.commands.registerCommand('edgecheck.dumpDiagnostics', dumpDiagnosticsToOutput)
  );

  if (cfg().get('autoScanOnSave') === true) {
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (doc.languageId === 'python' && doc.uri.scheme === 'file') {
          await runCurrentFile();
        }
      })
    );
  }

  ensureStatus();
}
function deactivate() { diag.clear(); META.clear(); }

module.exports = { activate, deactivate };
