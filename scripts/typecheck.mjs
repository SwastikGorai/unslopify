import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'src');
const jsonFiles = ['src/manifest.json'];

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else files.push(path);
  }
  return files;
}

function checkJavaScript(file) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`Syntax error: ${file}`)));
  });
}

for (const file of jsonFiles) JSON.parse(await readFile(resolve(root, file), 'utf8'));
const files = await filesIn(source);
await Promise.all(files.filter(file => file.endsWith('.js')).map(checkJavaScript));
console.log(`Checked ${files.length} source files (Node syntax + manifest JSON).`);
