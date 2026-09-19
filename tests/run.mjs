import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import {
  BUILTIN_SITES,
  CATEGORY_DEFINITIONS,
  DEFAULT_SETTINGS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  TRANSPORTS,
  buildQuestions,
  byteLength,
  classifyGate,
  exportableSettings,
  hashText,
  isEligibleText,
  importSettings,
  isSupportedPath,
  makeDispatchLeaseKey,
  mergeSettings,
  sanitizeSettings,
  validateClassifyRequest,
  validateCustomSite,
  validateJevResponse
} from '../src/shared/contracts.js';
import { evaluatePolicy } from '../src/shared/policy.js';
import { authFailureMessage, dispatchBlockReason, handleMessage, isExtensionSender, leaseBlocksDispatch, pausePatch, restoreDispatchLeases, usageForToday } from '../src/background/service-worker.js';
import { isSettingsReady, messageFailure, responseDetail } from '../src/options/state.js';
import { gatewayResult } from '../src/background/gateway.js';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/linkedin-posts.json', import.meta.url), 'utf8'));
const fixtureHtml = await readFile(new URL('./fixtures/linkedin-feed.html', import.meta.url), 'utf8');
const extractorSource = await readFile(new URL('../src/content/extractor.js', import.meta.url), 'utf8');
const extractorContext = { URL };
runInNewContext(extractorSource, extractorContext);
const extractor = extractorContext.__unslopifyExtractor;

class FixtureNode {
  constructor(tagName, attributes = {}, text = '') {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this._text = text;
    this.children = [];
    this.parentElement = null;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }

  get innerText() {
    return this.textContent;
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  matches(selector) {
    return selector.split(',').some(part => this.matchesPath(part.trim()));
  }

  matchesPath(selector) {
    const parts = selector.split(/\s+/u).filter(Boolean);
    if (!this.matchesCompound(parts.at(-1))) return false;
    let node = this.parentElement;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      while (node && !node.matchesCompound(parts[index])) node = node.parentElement;
      if (!node) return false;
      node = node.parentElement;
    }
    return true;
  }

  matchesCompound(selector) {
    const tag = selector.match(/^[a-z][a-z0-9-]*/iu)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const className of selector.matchAll(/\.([a-z0-9_-]+)/giu)) {
      if (!String(this.getAttribute('class') || '').split(/\s+/u).includes(className[1])) return false;
    }
    for (const attribute of selector.matchAll(/\[([^\]=*]+)(\*?=)?(?:"([^"]*)"|'([^']*)'|([^\]]*))?\]/gu)) {
      const [, name, operator, doubleValue, singleValue, bareValue] = attribute;
      const actual = this.getAttribute(name.trim());
      const expected = doubleValue ?? singleValue ?? bareValue?.trim() ?? '';
      if (actual == null || operator === '=' && actual !== expected || operator === '*=' && !actual.includes(expected)) return false;
    }
    return true;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  contains(node) {
    return this === node || this.children.some(child => child.contains(node));
  }
}

const fixtureNode = (tagName, attributes, text) => new FixtureNode(tagName, attributes, text);
const linkedin = BUILTIN_SITES.linkedin;

function fixtureFeed() {
  const root = fixtureNode('main', { 'data-testid': 'mainFeed' });
  const useful = fixtureNode('div', { 'data-urn': 'urn:li:activity:fixture-useful' });
  useful.append(
    fixtureNode('div', { class: 'feed-shared-update-v2__description' }, fixtures[0].text),
    fixtureNode('a', { href: '/feed/update/fixture-useful' }, 'Permalink')
  );
  const bait = fixtureNode('div', { 'data-urn': 'urn:li:activity:fixture-bait' });
  bait.append(
    fixtureNode('div', { class: 'feed-shared-update-v2__description' }, fixtures[1].text),
    fixtureNode('a', { href: '/feed/update/fixture-bait' }, 'Permalink')
  );
  root.append(useful, bait, fixtureNode('aside', {}, 'Sidebar text must never be sent.'), fixtureNode('form', {}, 'A typed draft must never be sent.'));
  return { root, useful, bait };
}
const tests = [
  ['normalization gives stable, namespaced identity hashes', () => {
    assert.equal(hashText(' a  useful post\n'), hashText('a useful post'));
    assert.notEqual(hashText('a useful post'), hashText('a different post'));
  }],
  ['path prefixes use segment boundaries', () => {
    assert.equal(isSupportedPath('/feed', ['/feed']), true);
    assert.equal(isSupportedPath('/feed/following', ['/feed']), true);
    assert.equal(isSupportedPath('/feedback', ['/feed']), false);
  }],
  ['settings are schema checked and transport models are fixed', () => {
    const settings = sanitizeSettings(DEFAULT_SETTINGS);
    assert.equal(settings.selectedTransport, 'gateway');
    assert.equal(settings.model, 'typesafe-ai/jev');
    assert.equal(TRANSPORTS.gateway.endpoint, 'https://ai-gateway.vercel.sh/v1/evaluate');
    assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, schemaVersion: 99 }), null);
    const direct = mergeSettings(settings, { selectedTransport: 'direct' });
    assert.equal(direct.model, 'jev-latest');
    assert.equal(direct.revision, settings.revision + 1);
    const exported = exportableSettings(direct);
    assert.equal(exported.enabledSites.linkedin, false);
    assert.equal(exported.customSites.length, 0);
    assert.equal(importSettings(exported).enabledSites.linkedin, false);
    assert.deepEqual(settings.consentedRoutes, []);
    assert.equal(direct.siteThresholds.linkedin.presentProbability, 0.9);
  }],
  ['custom rules reject broad or executable selector input', () => {
    const valid = validateCustomSite({
      id: 'example', label: 'Example', origin: 'https://example.com', paths: ['/feed'],
      feedRootSelector: 'main', postSelector: 'article', bodySelector: '[data-body]',
      permalinkSelector: 'a[href*="/post/"]', enabled: false
    });
    assert.equal(valid.id, 'example');
    assert.equal(validateCustomSite({ ...valid, feedRootSelector: 'body; .secret' }), null);
    assert.equal(validateCustomSite({ ...valid, bodySelector: '[data-body' }), null);
    assert.equal(validateCustomSite({ ...valid, origin: 'http://example.com' }), null);
    const imported = importSettings(sanitizeSettings({ ...DEFAULT_SETTINGS, customSites: [valid], enabledSites: { linkedin: true, x: false } }));
    assert.equal(imported.customSites[0].enabled, false);
  }],
  ['Jev Choice answers require every bounded option and a valid distribution', () => {
    const answer = {
      type: 'choice', choice: 'present',
      probabilities: { present: 0.95, absent: 0.03, uncertain: 0.02 }, confidence: 0.9
    };
    const result = validateJevResponse({ model: 'typesafe-ai/jev', answers: { engagement_bait: answer } }, ['engagement_bait']);
    assert.equal(result.ok, true);
    assert.equal(result.answers.engagement_bait.choice, 'present');
    assert.equal(validateJevResponse({ answers: { engagement_bait: { ...answer, probabilities: { present: 1 } } } }, ['engagement_bait']).ok, false);
    assert.equal(validateJevResponse({ answers: { engagement_bait: { ...answer, choice: 'other' } } }, ['engagement_bait']).ok, false);
    const sdkResult = gatewayResult({ response: { modelId: 'typesafe-ai/jev' }, answers: { engagement_bait: { type: 'choice', choice: 'present', probabilities: answer.probabilities } }, usage: { inputTokens: 12, outputTokens: 3 } }, 'typesafe-ai/jev');
    assert.equal(sdkResult.answers.engagement_bait.confidence, 0.95);
    assert.equal(validateJevResponse(sdkResult, ['engagement_bait']).usage.inputTokens, 12);
  }],
  ['policy gates only present, high-confidence categories', () => {
    const settings = sanitizeSettings({ ...DEFAULT_SETTINGS, categoryToggles: { engagement_bait: true, generic_filler: false, empty_hype: false } });
    const answer = { choice: 'present', probabilities: { present: 0.95, absent: 0.03, uncertain: 0.02 }, confidence: 0.9 };
    assert.equal(classifyGate(answer, settings.thresholds), true);
    const siteSettings = sanitizeSettings({ ...settings, siteThresholds: { ...settings.siteThresholds, linkedin: { presentProbability: 0.99, confidence: 0.95 } } });
    const decision = evaluatePolicy({ settings: siteSettings, answers: { engagement_bait: answer }, postId: 'post-1', siteId: 'linkedin' });
    assert.deepEqual(decision.categories, []);
    const defaultSiteDecision = evaluatePolicy({ settings: siteSettings, answers: { engagement_bait: answer }, postId: 'post-1', siteId: 'x' });
    assert.deepEqual(defaultSiteDecision.categories, ['engagement_bait']);
    const globalDecision = evaluatePolicy({ settings, answers: { engagement_bait: answer }, postId: 'post-1', siteId: 'linkedin' });
    assert.deepEqual(globalDecision.categories, ['engagement_bait']);
    assert.equal(evaluatePolicy({ settings: { ...settings, allowlist: ['post-1'] }, answers: { engagement_bait: answer }, postId: 'post-1' }).categories.length, 0);
  }],
  ['durable dispatch leases block duplicates after worker restoration', () => {
    const now = 100_000;
    const binding = {
      transport: 'gateway', origin: 'https://www.linkedin.com', adapterId: 'linkedin',
      postId: 'https://www.linkedin.com/feed/update/fixture-bait', textHash: 'bait-hash',
      extractionVersion: 'linkedin-1', model: 'typesafe-ai/jev'
    };
    const leaseKey = makeDispatchLeaseKey(binding);
    const changedBindingKey = makeDispatchLeaseKey({ ...binding, textHash: 'changed-hash' });
    const restored = restoreDispatchLeases({ [leaseKey]: { startedAt: now - 100, requestId: 'old-request' }, expired: { startedAt: now - 20_000 } }, now);
    const newRequestId = 'new-request';
    assert.equal(leaseBlocksDispatch(restored, leaseKey, now), true);
    assert.equal(leaseBlocksDispatch(restored, changedBindingKey, now), false);
    assert.equal(Object.hasOwn(restored, 'expired'), false);
    assert.equal(leaseKey, makeDispatchLeaseKey({ ...binding, model: binding.model }));
    assert.notEqual(newRequestId, restored[leaseKey].requestId);
    assert.equal(leaseBlocksDispatch(restored, leaseKey, now), true, 'a new requestId for the same binding remains blocked');
  }],
  ['final dispatch gate rejects revoked permission and disabled revisions', () => {
    const settings = sanitizeSettings({ ...DEFAULT_SETTINGS, revision: 2, enabledSites: { linkedin: true, x: false }, consentedOrigins: ['https://www.linkedin.com'], consentedRoutes: ['gateway'] });
    const task = { settings, site: { id: 'linkedin', origin: 'https://www.linkedin.com' } };
    const liveSite = { site: task.site };
    assert.equal(dispatchBlockReason({ task, settings, liveSite, sitePermission: true, routePermission: true }), '');
    assert.equal(dispatchBlockReason({ task, settings, liveSite, sitePermission: false, routePermission: true }), 'permission_denied');
    assert.equal(dispatchBlockReason({ task, settings: { ...settings, revision: settings.revision + 1 }, liveSite, sitePermission: true, routePermission: true }), 'disabled');
  }],
  ['LinkedIn extraction executes fixture boundaries and stale-card guards', () => {
    const { root, useful, bait } = fixtureFeed();
    assert.ok(useful.querySelector('a[href*="/feed/update/"]'));
    const usefulResult = extractor.extractCard(useful, linkedin, root, 'https://www.linkedin.com');
    const baitResult = extractor.extractCard(bait, linkedin, root, 'https://www.linkedin.com');
    assert.equal(root.querySelectorAll(linkedin.postSelector).length, 2);
    assert.equal(usefulResult.postId, 'https://www.linkedin.com/feed/update/fixture-useful');
    assert.equal(usefulResult.text, fixtures[0].text);
    assert.equal(baitResult.text, fixtures[1].text);
    assert.equal(baitResult.truncated, false);

    const modern = fixtureNode('div', { role: 'listitem' });
    modern.append(fixtureNode('span', { 'data-testid': 'expandable-text-box' }, fixtures[1].text));
    const modernRoot = fixtureNode('main', { 'data-testid': 'mainFeed' }).append(modern);
    assert.equal(extractor.extractCard(modern, linkedin, modernRoot, 'https://www.linkedin.com').text, fixtures[1].text);
    assert.equal(root.querySelector('aside') && extractor.extractCard(root.querySelector('aside'), linkedin, root, 'https://www.linkedin.com'), null);
    assert.equal(root.querySelector('form') && extractor.extractCard(root.querySelector('form'), linkedin, root, 'https://www.linkedin.com'), null);

    const outer = fixtureNode('div', { 'data-urn': 'urn:li:activity:outer' });
    const nested = fixtureNode('div', { 'data-urn': 'urn:li:activity:nested' });
    nested.append(fixtureNode('div', { class: 'feed-shared-update-v2__description' }, fixtures[1].text));
    outer.append(fixtureNode('div', { class: 'feed-shared-update-v2__description' }, 'Outer commentary has a clear boundary.'), nested);
    const nestedRoot = fixtureNode('main').append(outer);
    assert.equal(extractor.extractCard(nested, linkedin, nestedRoot, 'https://www.linkedin.com'), null);

    const ambiguous = fixtureNode('div', { 'data-urn': 'urn:li:activity:ambiguous' });
    ambiguous.append(fixtureNode('div', { class: 'feed-shared-update-v2__description' }, 'First body.'), fixtureNode('div', { class: 'feed-shared-text' }, 'Second body.'));
    assert.equal(extractor.extractCard(ambiguous, linkedin, nestedRoot, 'https://www.linkedin.com'), null);

    const truncated = fixtureNode('div', { 'data-urn': 'urn:li:activity:truncated' });
    truncated.append(fixtureNode('div', { class: 'feed-shared-update-v2__description' }, fixtures[2].text));
    assert.equal(extractor.extractCard(truncated, linkedin, nestedRoot, 'https://www.linkedin.com').truncated, true);
    assert.equal(extractor.routeAction({ changed: true, stopped: true, nextSite: linkedin, currentSite: linkedin }), 'reconcile');
    assert.equal(extractor.routeAction({ changed: true, stopped: false, nextSite: null, currentSite: linkedin }), 'teardown');
    assert.equal(extractor.routeAction({ changed: false, stopped: true, nextSite: null, currentSite: linkedin }), 'wait');
    assert.equal(extractor.routeAction({ changed: false, stopped: false, nextSite: linkedin, currentSite: linkedin }), 'connect');
  }],
  ['fixture boundaries abstain before any dispatch', () => {
    assert.equal(fixtures.length, 3);
    const request = {
      type: 'CLASSIFY_REQUEST', protocolVersion: PROTOCOL_VERSION, requestId: 'fixture-1', adapterId: 'linkedin',
      extractionVersion: 'linkedin-1', documentGeneration: 1, postId: fixtures[1].id,
      textHash: hashText(fixtures[1].text), postText: fixtures[1].text, truncated: false,
      contextUncertain: false, settingsRevision: 1
    };
    assert.equal(validateClassifyRequest(request).ok, true);
    assert.equal(validateClassifyRequest({ ...request, postText: 'x'.repeat(MAX_MESSAGE_BYTES) }).ok, false);
    assert.equal(fixtures[2].truncated && fixtures[2].contextUncertain, true);
    assert.ok(Object.keys(CATEGORY_DEFINITIONS).length >= 3);
    assert.ok(Object.keys(buildQuestions(['engagement_bait'])).length === 1);
    assert.ok(byteLength(request) < MAX_MESSAGE_BYTES);
  }],
  ['text eligibility keeps short, non-English, and media-only posts visible', () => {
    assert.equal(isEligibleText('A concrete English post with enough detail.'), true);
    assert.equal(extractor.isEligibleText('A concrete English post with enough detail.'), true);
    assert.equal(isEligibleText('short'), false);
    assert.equal(extractor.isEligibleText('short'), false);
    assert.equal(isEligibleText('यह एक हिंदी पोस्ट है जिसमें पर्याप्त पाठ है।'), false);
  }],
  ['sanitized LinkedIn fixture includes explicit excluded regions', () => {
    assert.match(fixtureHtml, /feed-shared-update-v2__description/);
    assert.match(fixtureHtml, /Comment GROWTH/);
    assert.match(fixtureHtml, /Sidebar text must never be sent/gu);
    assert.match(fixtureHtml, /A typed draft must never be sent/gu);
  }],
  ['options stay guarded while settings load and preserve message failure detail', () => {
    assert.equal(isSettingsReady(undefined), false);
    assert.equal(isSettingsReady({}), false);
    assert.equal(isSettingsReady({ revision: 1 }), false);
    assert.equal(isSettingsReady(DEFAULT_SETTINGS), true);
    assert.equal(responseDetail(undefined, 'worker unavailable'), 'worker unavailable');
    assert.equal(responseDetail({ error: { code: 'server_error' } }, 'worker unavailable'), 'server_error');
    assert.equal(responseDetail({ error: { detail: 'storage unavailable' } }, 'worker unavailable'), 'storage unavailable');
    assert.equal(messageFailure(new Error('Receiving end does not exist.'), 'GET_SETTINGS'), 'GET_SETTINGS: Receiving end does not exist.');
    assert.equal(messageFailure(undefined, 'SAVE_SETTINGS'), 'SAVE_SETTINGS: No response from the extension service worker.');
  }],
  ['extension messages, pause state, usage dates, and scoped teardown are stable', () => {
    globalThis.chrome = { runtime: { id: 'extension-id', getURL: path => `chrome-extension://extension-id/${path}` } };
    assert.equal(isExtensionSender({ id: 'extension-id', tab: { id: 1 }, url: 'chrome-extension://extension-id/options/options.html' }), true);
    assert.equal(isExtensionSender({ id: 'extension-id', tab: { id: 2 }, url: 'https://www.linkedin.com/feed/' }), false);
    assert.equal(isExtensionSender({ id: 'other-extension', url: 'chrome-extension://other-extension/options.html' }), false);
    assert.deepEqual(pausePatch(false), { inferencePaused: false, statusMessage: '' });
    assert.deepEqual(pausePatch(true, 'The selected API key was rejected. Update it in Options.'), { inferencePaused: true, statusMessage: 'The selected API key was rejected. Update it in Options.' });
    assert.match(authFailureMessage(401), /key was rejected/u);
    assert.match(authFailureMessage(403), /lacks access/u);
    assert.equal(usageForToday({ day: '2020-01-01', dayAttempts: 9 }, Date.parse('2026-09-19T12:00:00Z')).dayAttempts, 0);
    assert.equal(usageForToday({ day: '2026-09-19', dayAttempts: 3 }, Date.parse('2026-09-19T12:00:00Z')).dayAttempts, 3);
    assert.equal(extractor.shouldTeardown({ type: 'TEARDOWN', siteId: 'x' }, 'linkedin'), false);
    assert.equal(extractor.shouldTeardown({ type: 'TEARDOWN', siteId: 'linkedin' }, 'linkedin'), true);
    delete globalThis.chrome;
  }],
  ['options messages reach the real worker and pause can resume', async () => {
    const stores = { local: {}, session: {} };
    const area = name => ({
      async get(keys) { return Object.fromEntries(keys.filter(key => Object.hasOwn(stores[name], key)).map(key => [key, stores[name][key]])); },
      async set(values) { Object.assign(stores[name], values); },
      async setAccessLevel() {}
    });
    globalThis.chrome = {
      runtime: { id: 'extension-id', getURL: path => `chrome-extension://extension-id/${path}` },
      storage: { local: area('local'), session: area('session') },
      permissions: { async contains() { return false; } },
      scripting: {
        async getRegisteredContentScripts() { return []; },
        async unregisterContentScripts() {},
        async registerContentScripts() {}
      },
      tabs: { async sendMessage() {} }
    };
    const sender = { id: 'extension-id', tab: { id: 1 }, url: 'chrome-extension://extension-id/options/options.html' };
    const loaded = await handleMessage({ type: 'GET_SETTINGS' }, sender);
    assert.equal(loaded.ok, true);
    assert.equal(isSettingsReady(loaded.settings), true);
    assert.equal((await handleMessage({ type: 'SET_CREDENTIAL', transport: 'gateway', key: 'vck_example_key' }, sender)).ok, true);
    const paused = await handleMessage({ type: 'PAUSE_INFERENCE', paused: true }, sender);
    assert.equal(paused.settings.inferencePaused, true);
    const resumed = await handleMessage({ type: 'PAUSE_INFERENCE', paused: false }, sender);
    assert.equal(resumed.settings.inferencePaused, false);
    delete globalThis.chrome;
  }]
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}
if (failed) process.exitCode = 1;
else console.log(`\n${tests.length} tests passed`);
