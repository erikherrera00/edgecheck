// scripts/bundle.js
// One-shot production bundle to dist/extension.js
const esbuild = require('esbuild');
const path = require('path');

(async () => {
  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'extension.js')],
      outfile: path.join(__dirname, '..', 'dist', 'extension.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: ['node18'],
      external: ['vscode'],       // VS Code API is provided at runtime
      sourcemap: false,
      minify: true,
      legalComments: 'none'
    });
    console.log('[edgecheck] bundle complete -> dist/extension.js');
  } catch (err) {
    console.error('[edgecheck] bundle failed');
    console.error(err);
    process.exit(1);
  }
})();
