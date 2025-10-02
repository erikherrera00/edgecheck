const vscode = require('vscode');

class TestProvider {
  provideCodeActions(document, range, context) {
    const a = new vscode.CodeAction('Test Quick Fix', vscode.CodeActionKind.QuickFix);
    const e = new vscode.WorkspaceEdit();
    const line = Math.max(0, range?.start?.line ?? 0);
    e.insert(document.uri, new vscode.Position(line, 0), '# test quick fix\n');
    a.edit = e;
    return [a];
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: 'python' },  // no scheme filter
      new TestProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );
}
function deactivate() {}
module.exports = { activate, deactivate };
