import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const extension = resolve(root, 'dist');
const chrome = process.env.CHROME_BIN || process.env.CHROMIUM_BIN;

await access(resolve(extension, 'manifest.json'), constants.R_OK).catch(() => {
  throw new Error('dist/ is missing; run npm run build first');
});

if (!chrome) {
  console.log('not run: set CHROME_BIN or CHROMIUM_BIN for a real Chromium extension smoke test');
  process.exit(0);
}

const fixture = await readFile(resolve(root, 'tests/fixtures/linkedin-feed.html'), 'utf8');
const server = createServer((request, response) => {
  if (request.url === '/feed') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture);
    return;
  }
  response.writeHead(404);
  response.end('not found');
});
const tempRoot = await mkdtemp(resolve(tmpdir(), 'unslopify-e2e-'));
const testExtension = resolve(tempRoot, 'extension');
const profile = resolve(tempRoot, 'profile');

try {
  await cp(extension, testExtension, { recursive: true });
  const manifestPath = resolve(testExtension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...manifest.host_permissions, 'http://127.0.0.1/*'])];
  manifest.content_scripts = [{
    matches: ['http://127.0.0.1/*'],
    js: ['content/extractor.js', 'content/content.js', 'e2e-probe.js'],
    run_at: 'document_idle',
    all_frames: false
  }];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await writeFile(resolve(testExtension, 'e2e-probe.js'), `(() => {
  const site = {
    id: 'linkedin',
    origin: location.origin,
    postSelector: '[data-urn*="activity"], [data-urn*="ugcPost"]',
    bodySelector: '[data-test-id="main-feed-activity-card__commentary"], .feed-shared-update-v2__description, .feed-shared-text',
    permalinkSelector: 'a[href*="/feed/update/"], a[href*="/posts/"]',
    extractionVersion: 'linkedin-1'
  };
  const root = document.querySelector('main');
  const cards = root ? [...root.querySelectorAll(site.postSelector)] : [];
  const extractor = globalThis.__unslopifyExtractor;
  const extracted = extractor && root ? cards.map(card => extractor.extractCard(card, site, root, location.origin)) : [];
  const result = {
    cardCount: cards.length,
    extracted: extracted.map(item => item && ({ postId: item.postId, text: item.text, truncated: item.truncated, contextUncertain: item.contextUncertain })),
    helperLoaded: Boolean(extractor),
    sidebarSent: extracted.some(item => item?.text.includes('Sidebar text')),
    draftSent: extracted.some(item => item?.text.includes('typed draft'))
  };
  document.documentElement.dataset.unslopifyE2e = btoa(JSON.stringify(result));
})();`);

  await new Promise((resolvePromise, reject) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/feed`;
  const output = await new Promise((resolvePromise, reject) => {
    const child = spawn(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${testExtension}`,
      `--load-extension=${testExtension}`,
      '--virtual-time-budget=2000',
      '--dump-dom',
      url
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Chromium fixture probe timed out'));
    }, 15_000);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`Chromium exited with ${code}: ${stderr.slice(-500)}`));
    });
  });
  const marker = output.stdout.match(/data-unslopify-e2e="([A-Za-z0-9+/=]+)"/u);
  assert.ok(marker, `Chromium did not expose the fixture probe result. Output: ${output.stdout.slice(-500)}`);
  const probe = JSON.parse(Buffer.from(marker[1], 'base64').toString('utf8'));
  assert.equal(probe.helperLoaded, true);
  assert.equal(probe.cardCount, 2);
  assert.deepEqual(probe.extracted.map(item => item?.postId), [
    `${url.slice(0, url.indexOf('/', 8))}/feed/update/fixture-useful`,
    `${url.slice(0, url.indexOf('/', 8))}/feed/update/fixture-bait`
  ]);
  assert.equal(probe.extracted.some(item => item?.text.includes('Sidebar text')), false);
  assert.equal(probe.extracted.some(item => item?.text.includes('typed draft')), false);
  console.log(`Chromium e2e passed: loaded dist with the sanitized fixture and extracted ${probe.cardCount} bounded cards.`);
} finally {
  await new Promise(resolvePromise => server.close(() => resolvePromise()));
  await rm(tempRoot, { recursive: true, force: true });
}
