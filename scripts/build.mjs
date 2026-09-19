import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'src');
const output = resolve(root, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
await build({
  entryPoints: [resolve(source, 'background/service-worker.js')],
  outfile: resolve(output, 'background/service-worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome102',
  legalComments: 'none'
});
await rm(resolve(output, 'background/gateway.js'));
await writeFile(resolve(output, 'BUILD.txt'), `Unslopify ${new Date().toISOString()}\n`);

console.log(`Built ${output}`);
