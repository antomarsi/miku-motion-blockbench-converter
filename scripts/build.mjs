// Bundles the Blockbench plugin (one self-contained file, as the plugin store requires)
// and the Node CLI. Run with `npm run build`.

import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
export const PLUGIN_ID = "mmd_motion_importer";

const shared = {
  bundle: true,
  target: "es2022",
  legalComments: "none",
  define: { __VERSION__: JSON.stringify(version) },
  loader: { ".bbmodel": "json" },
  logLevel: "info",
};

const pluginFile = resolve(root, `packages/plugin/dist/${PLUGIN_ID}.js`);
await mkdir(dirname(pluginFile), { recursive: true });
await build({
  ...shared,
  entryPoints: [resolve(root, "packages/plugin/src/plugin.ts")],
  outfile: pluginFile,
  platform: "browser", // also runs in the Blockbench web app: no Node APIs
  format: "iife",
});
// Blockbench reads the plugin's metadata from the file; keep a readable header on top.
const banner = `// MMD Motion Importer ${version} - https://github.com/antomarsi/miku-motion-blockbench-converter\n`;
await writeFile(pluginFile, banner + (await readFile(pluginFile, "utf8")));

await build({
  ...shared,
  entryPoints: [resolve(root, "packages/cli/src/main.ts")],
  outfile: resolve(root, "packages/cli/dist/miku-motion.mjs"),
  platform: "node",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
});
