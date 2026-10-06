const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const builds = [
  {
    // Extension host
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
  },
  {
    // Git Log webview
    entryPoints: ['src/webview/log/main.ts'],
    bundle: true,
    outfile: 'dist/webview/log.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
  },
];

(async () => {
  if (watch) {
    for (const options of builds) {
      const ctx = await esbuild.context(options);
      await ctx.watch();
    }
  } else {
    await Promise.all(builds.map((options) => esbuild.build(options)));
  }
})().catch(() => process.exit(1));
