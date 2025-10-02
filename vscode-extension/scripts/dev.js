// scripts/dev.js
// Watch mode for fast local development; rebuilds on file change
const esbuild = require('esbuild');
const path = require('path');

(async () => {
  try {
    const ctx = await esbuild.context({
      entryPoints: [path.join(__dirname, '..', 'extension.js')],
      outfile: path.join(__dirname, '..', 'dist', 'extension.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: ['node18'],
      external: ['vscode'],
      sourcemap: true,    // easier debugging in Extension Host
      minify: false
    });

    await ctx.watch();
    console.log('[edgecheck] dev watch ready → dist/extension.js (Ctrl+C to stop)');

    // keep process alive
    process.stdin.resume();
  } catch (err) {
    console.error('[edgecheck] watch failed');
    console.error(err);
    process.exit(1);
  }
})();
