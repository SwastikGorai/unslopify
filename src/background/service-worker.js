import {
  BUILTIN_SITES,
  CACHE_LIMIT,
  CACHE_TTL_MS,
  DEFAULT_SETTINGS,
  MAX_POST_TEXT,
  PROTOCOL_VERSION,
  RUBRIC_VERSION,
  TRANSPORTS,
  byteLength,
  buildQuestions,
  clone,
  effectiveCategoryIds,
  exportableSettings,
  importSettings,
  hashText,
  isEligibleText,
  makeCacheKey,
  makeDispatchLeaseKey,
  mergeSettings,
  redactedError,
  sanitizeSettings,
  siteForUrl,
  validateClassifyRequest,
  validateJevResponse
} from '../shared/contracts.js';
import { evaluateWithGateway, gatewayErrorStatus } from './gateway.js';

const SETTINGS_KEY = 'settings';
const USAGE_KEY = 'usage';
const COOLDOWN_KEY = 'cooldown';
const CACHE_KEY = 'decisionCache';
const LEASE_KEY = 'dispatchLeases';
const KEY_PREFIX = 'credential_';
const REQUEST_TIMEOUT_MS = 10_000;

function isLiveLease(lease, now = Date.now()) {
  return Boolean(lease && typeof lease === 'object' && Number.isFinite(lease.startedAt) && lease.startedAt > now - REQUEST_TIMEOUT_MS);
}

export function restoreDispatchLeases(stored, now = Date.now()) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).filter(([, lease]) => isLiveLease(lease, now)));
}

export function leaseBlocksDispatch(leases, leaseKey, now = Date.now()) {
  return Boolean(leases && isLiveLease(leases[leaseKey], now));
}

export function dispatchBlockReason({ task, settings, liveSite, sitePermission, routePermission }) {
  const taskSettings = task?.settings;
  const site = liveSite?.site;
  if (!taskSettings || !settings || !site || settings.revision !== taskSettings.revision || settings.selectedTransport !== taskSettings.selectedTransport || settings.model !== taskSettings.model || settings.inferencePaused || task.site?.id !== site.id || task.site?.origin !== site.origin || !(settings.enabledSites[site.id] || site.enabled)) return 'disabled';
  if (!settings.consentedRoutes.includes(settings.selectedTransport) || !settings.consentedOrigins.includes(site.origin) || sitePermission !== true || routePermission !== true) return 'permission_denied';
  return '';
}

const runtime = {
  settings: null,
  queue: [],
  inFlight: 0,
  pendingByTab: new Map(),
  controllers: new Map(),
  connectedTabs: new Map(),
  cache: new Map(),
  leases: new Map(),
  lastStatus: '',
  cacheHits: 0,
  writeChain: Promise.resolve(),
  initialized: null
};

export function isExtensionSender(sender) {
  const base = chrome.runtime.getURL('');
  return Boolean(sender?.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(base));
}

export function pausePatch(paused, statusMessage = '') {
  return { inferencePaused: paused, statusMessage: paused ? (statusMessage || 'Inference is paused; posts remain visible.') : '' };
}

export function authFailureMessage(status) {
  return status === 403
    ? 'The Gateway key or team lacks access to this model. Check AI Gateway model/provider allowlists and credits.'
    : 'The selected API key was rejected. Update it in Options.';
}

export function usageForToday(usage, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return usage?.day === day ? usage : { day, dayAttempts: 0 };
}

function isContentSender(sender) {
  return Boolean(sender?.id === chrome.runtime.id && sender.tab?.id >= 0 && sender.frameId === 0 && typeof sender.tab.url === 'string' && typeof sender.url === 'string' && sender.url === sender.tab.url);
}

async function storageSet(area, value) {
  await chrome.storage[area].set(value);
}

async function storageGet(area, keys) {
  return chrome.storage[area].get(keys);
}

async function initialize() {
  if (runtime.initialized) return runtime.initialized;
  const initialization = (async () => {
    await chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    await chrome.storage.session?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    const stored = (await storageGet('local', [SETTINGS_KEY]))[SETTINGS_KEY];
    const parsedSettings = sanitizeSettings(stored);
    runtime.settings = parsedSettings ?? { ...clone(DEFAULT_SETTINGS), statusMessage: stored ? 'Stored settings were invalid; affected sites were disabled.' : '' };
    if (!stored || !parsedSettings) await storageSet('local', { [SETTINGS_KEY]: runtime.settings });
    const cache = (await storageGet('session', [CACHE_KEY]))[CACHE_KEY];
    if (cache && typeof cache === 'object') {
      for (const [key, item] of Object.entries(cache)) {
        if (item?.expiresAt > Date.now() && item?.result) runtime.cache.set(key, item);
      }
    }
    const leases = restoreDispatchLeases((await storageGet('session', [LEASE_KEY]))[LEASE_KEY]);
    runtime.leases.clear();
    for (const [leaseKey, lease] of Object.entries(leases)) runtime.leases.set(leaseKey, lease);
    await storageSet('session', { [LEASE_KEY]: leases });
    await reconcileRegistrations();
  })();
  let tracked;
  tracked = initialization.catch(error => {
    if (runtime.initialized === tracked) runtime.initialized = null;
    throw error;
  });
  runtime.initialized = tracked;
  return tracked;
}

function serializedWrite(fn) {
  const next = runtime.writeChain.then(fn, fn);
  runtime.writeChain = next.catch(() => undefined);
  return next;
}

function originPermission(origin) {
  return `${origin}/*`;
}

function registrationId(siteId) {
  return `unslopify-${siteId}`;
}

function matchesForSite(site) {
  return site.paths.flatMap(path => [`${site.origin}${path}`, `${site.origin}${path}/*`]);
}

async function hasPermission(origin) {
  try { return await chrome.permissions.contains({ origins: [originPermission(origin)] }); } catch { return false; }
}

async function reconcileRegistrations() {
  const settings = runtime.settings;
  const sites = [...Object.values(BUILTIN_SITES), ...settings.customSites];
  try {
    const desired = new Set(sites.filter(site => settings.enabledSites[site.id] || site.enabled).map(site => registrationId(site.id)));
    const registered = await chrome.scripting.getRegisteredContentScripts();
    for (const script of registered) if (script.id.startsWith('unslopify-') && !desired.has(script.id)) await chrome.scripting.unregisterContentScripts({ ids: [script.id] });
  } catch { /* registration reconciliation below is still safe */ }
  for (const site of sites) {
    const enabled = Boolean(settings.enabledSites[site.id] || settings.customSites.some(item => item.id === site.id && item.enabled));
    if (!enabled || !(await hasPermission(site.origin))) {
      await unregisterSite(site.id);
      if (enabled) await disableSiteWithoutPermission(site.id);
      continue;
    }
    await registerSite(site);
  }
}

async function registerSite(site) {
  const id = registrationId(site.id);
  try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch { /* not registered */ }
  try {
    await chrome.scripting.registerContentScripts([{
      id,
      matches: matchesForSite(site),
      js: ['content/extractor.js', 'content/content.js'],
      css: ['content/content.css'],
      world: 'ISOLATED',
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true
    }]);
  } catch {
    // A denied or revoked host permission is handled by the next reconciliation.
  }
}

async function unregisterSite(siteId) {
  try { await chrome.scripting.unregisterContentScripts({ ids: [registrationId(siteId)] }); } catch { /* already absent */ }
}

async function injectExistingTabs(site) {
  try {
    const tabs = await chrome.tabs.query({ url: matchesForSite(site) });
    for (const tab of tabs) {
      if (tab.id == null) continue;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content/extractor.js', 'content/content.js'] });
        await chrome.scripting.insertCSS({ target: { tabId: tab.id, frameIds: [0] }, files: ['content/content.css'] });
      } catch { /* restricted or already-closed tab */ }
    }
  } catch { /* querying tabs can be unavailable without a matching grant */ }
}

async function removeInjectedStyles(site) {
  try {
    const tabs = await chrome.tabs.query({ url: matchesForSite(site) });
    for (const tab of tabs) {
      if (tab.id == null) continue;
      try { await chrome.scripting.removeCSS({ target: { tabId: tab.id, frameIds: [0] }, files: ['content/content.css'] }); } catch { /* style was not inserted */ }
    }
  } catch { /* no matching tabs */ }
}

async function disableSiteWithoutPermission(siteId) {
  const next = mergeSettings(runtime.settings, {
    enabledSites: { ...runtime.settings.enabledSites, [siteId]: false },
    customSites: runtime.settings.customSites.map(site => site.id === siteId ? { ...site, enabled: false } : site),
    statusMessage: 'Site permission was removed; the site is disabled.'
  });
  if (next) {
    runtime.settings = next;
    await storageSet('local', { [SETTINGS_KEY]: next });
  }
}

function currentSettings() {
  return runtime.settings ?? clone(DEFAULT_SETTINGS);
}

function publicSettings(settings) {
  return clone(settings);
}

function bindingResult(request, result) {
  return {
    type: 'CLASSIFY_RESULT',
    protocolVersion: PROTOCOL_VERSION,
    requestId: request?.requestId,
    adapterId: request?.adapterId,
    extractionVersion: request?.extractionVersion,
    documentGeneration: request?.documentGeneration,
    postId: request?.postId,
    textHash: request?.textHash,
    settingsRevision: request?.settingsRevision,
    rubricVersion: RUBRIC_VERSION,
    ...result
  };
}

function statusResult(status, error) {
  return error ? { status, error: redactedError(error.code, error.detail) } : { status };
}

function rememberStatus(code) {
  runtime.lastStatus = {
    missing_key: 'Enter the selected route key in Options.',
    budget_exhausted: 'The local inference budget is exhausted; posts remain visible.',
    rate_limited: 'The provider is rate limiting requests; posts remain visible during cooldown.',
    cooldown: 'Inference is cooling down; posts remain visible.',
    invalid_response: 'The provider returned an invalid typed answer; the post remains visible.',
    timeout: 'The inference request timed out; the post remains visible.',
    offline: 'The inference request could not reach the provider; the post remains visible.',
    server_error: 'The provider returned an error; the post remains visible.',
    queue_full: 'The local queue is full; this post remains visible.',
    permission_denied: 'Review the recipient disclosure and grant the selected route before enabling inference.'
  }[code] || runtime.lastStatus;
}

function tabPendingCount(tabId) {
  return runtime.pendingByTab.get(tabId) ?? 0;
}

function incrementTabPending(tabId) {
  runtime.pendingByTab.set(tabId, tabPendingCount(tabId) + 1);
}

function decrementTabPending(tabId) {
  const count = tabPendingCount(tabId) - 1;
  if (count > 0) runtime.pendingByTab.set(tabId, count);
  else runtime.pendingByTab.delete(tabId);
}

async function validateContentRequest(request, sender) {
  const checked = validateClassifyRequest(request);
  if (!checked.ok || !isContentSender(sender)) return { ok: false, result: bindingResult(request, statusResult('error', { code: checked.error ?? 'invalid_message' })) };
  const settings = currentSettings();
  const site = siteForUrl(sender.tab.url, settings);
  if (!site || site.id !== request.adapterId || !settings.enabledSites[site.id] && !site.enabled) return { ok: false, result: bindingResult(request, statusResult('error', { code: 'disabled' })) };
  if (request.postText.length > MAX_POST_TEXT || request.truncated || request.contextUncertain || !isEligibleText(request.postText) || hashText(request.postText) !== request.textHash) return { ok: false, result: bindingResult(request, statusResult('error', { code: 'unsupported' })) };
  if (byteLength(request) > 64 * 1024) return { ok: false, result: bindingResult(request, statusResult('error', { code: 'message_too_large' })) };
  const categories = effectiveCategoryIds(settings);
  if (!categories.length || settings.inferencePaused) return { ok: false, result: bindingResult(request, statusResult('error', { code: settings.inferencePaused ? 'paused' : 'disabled' })) };
  if (!settings.consentedRoutes.includes(settings.selectedTransport)) { rememberStatus('permission_denied'); return { ok: false, result: bindingResult(request, statusResult('error', { code: 'permission_denied', detail: 'disclosure_required' })) }; }
  return { ok: true, site, settings, categories };
}

async function currentTabSite(tabId, settings) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const site = siteForUrl(tab.url, settings);
    return site && { site, tab };
  } catch { return null; }
}

async function finalDispatchCheck(task, transport) {
  const settings = currentSettings();
  const live = await currentTabSite(task.sender.tab.id, settings);
  const sitePermission = live ? await hasPermission(live.site.origin) : false;
  const routePermission = live ? await hasPermission(transport.origin) : false;
  const reason = dispatchBlockReason({ task, settings, liveSite: live, sitePermission, routePermission });
  return { ok: !reason, reason };
}

async function handleClassify(request, sender) {
  const validation = await validateContentRequest(request, sender);
  if (!validation.ok) return validation.result;
  const { settings, site, categories } = validation;
  const tabId = sender.tab.id;
  if (tabPendingCount(tabId) >= settings.limits.perTab || runtime.queue.length >= settings.limits.queue) { rememberStatus('queue_full'); return bindingResult(request, statusResult('error', { code: 'queue_full' })); }
  const key = makeCacheKey({ transport: settings.selectedTransport, origin: site.origin, textHash: request.textHash, extractionVersion: request.extractionVersion, model: settings.model });
  const cached = runtime.cache.get(key);
  if (cached?.expiresAt > Date.now() && categories.every(id => cached.result.answers[id])) { runtime.cacheHits += 1; return bindingResult(request, { status: 'classified', transportId: settings.selectedTransport, modelIdentifier: settings.model, answers: clone(cached.result.answers), cached: true }); }
  if (cached) runtime.cache.delete(key);

  incrementTabPending(tabId);
  return new Promise(resolve => {
    runtime.queue.push({ request, sender, settings, site, categories, key, resolve });
    pumpQueue();
  }).finally(() => decrementTabPending(tabId));
}

function pumpQueue() {
  while (runtime.inFlight < currentSettings().limits.concurrency && runtime.queue.length) {
    const task = runtime.queue.shift();
    runtime.inFlight += 1;
    dispatch(task).then(task.resolve, error => task.resolve(bindingResult(task.request, statusResult('error', { code: 'server_error', detail: error.message })))).finally(() => {
      runtime.inFlight -= 1;
      pumpQueue();
    });
  }
}

async function reserveUsage(settings) {
  return serializedWrite(async () => {
    const now = Date.now();
    const stored = (await storageGet('local', [USAGE_KEY, COOLDOWN_KEY]));
    const usage = stored[USAGE_KEY] ?? {};
    const day = new Date(now).toISOString().slice(0, 10);
    const minute = Math.floor(now / 60_000);
    const next = {
      day,
      dayAttempts: usage.day === day ? usage.dayAttempts ?? 0 : 0,
      minute,
      minuteAttempts: usage.minute === minute ? usage.minuteAttempts ?? 0 : 0
    };
    const cooldown = stored[COOLDOWN_KEY];
    if (cooldown?.until > now) return { ok: false, error: { code: cooldown.code === 'rate_limited' ? 'rate_limited' : 'cooldown', detail: `retry_after_${Math.ceil((cooldown.until - now) / 1000)}s` } };
    if (next.dayAttempts >= settings.limits.daily || next.minuteAttempts >= settings.limits.perMinute) return { ok: false, error: { code: 'budget_exhausted', detail: 'local budget reached' } };
    next.dayAttempts += 1;
    next.minuteAttempts += 1;
    await storageSet('local', { [USAGE_KEY]: next });
    return { ok: true };
  });
}

async function setCooldown(code, seconds) {
  const bounded = Math.max(1, Math.min(3_600, Number.isFinite(seconds) ? seconds : 60));
  await storageSet('local', { [COOLDOWN_KEY]: { code, until: Date.now() + bounded * 1000 } });
}

async function setLease(leaseKey, lease) {
  return serializedWrite(async () => {
    const stored = restoreDispatchLeases((await storageGet('session', [LEASE_KEY]))[LEASE_KEY]);
    runtime.leases.clear();
    for (const [storedLeaseKey, storedLease] of Object.entries(stored)) runtime.leases.set(storedLeaseKey, storedLease);
    if (lease) {
      if (leaseBlocksDispatch(runtime.leases, leaseKey)) return false;
      stored[leaseKey] = lease;
      runtime.leases.set(leaseKey, lease);
    } else {
      delete stored[leaseKey];
      runtime.leases.delete(leaseKey);
    }
    await storageSet('session', { [LEASE_KEY]: stored });
    return true;
  });
}

async function getCredential(transport) {
  const key = (await storageGet('session', [`${KEY_PREFIX}${transport.id}`]))[`${KEY_PREFIX}${transport.id}`];
  return typeof key === 'string' && key.length >= 8 && key.length <= 500 ? key : '';
}

async function dispatch(task) {
  const { request, settings, categories, key: cacheKey } = task;
  const live = await currentTabSite(task.sender.tab.id, currentSettings());
  if (!live || live.site.id !== task.site.id || currentSettings().revision !== settings.revision) return bindingResult(request, statusResult('error', { code: 'disabled' }));
  const transport = TRANSPORTS[settings.selectedTransport];
  const leaseKey = makeDispatchLeaseKey({
    transport: settings.selectedTransport,
    origin: task.site.origin,
    adapterId: task.site.id,
    postId: request.postId,
    textHash: request.textHash,
    extractionVersion: request.extractionVersion,
    model: settings.model
  });
  if (leaseBlocksDispatch(runtime.leases, leaseKey)) return bindingResult(request, statusResult('error', { code: 'in_flight' }));
  const claimed = await setLease(leaseKey, { startedAt: Date.now(), tabId: task.sender.tab.id, requestId: request.requestId, settingsRevision: settings.revision });
  if (!claimed) return bindingResult(request, statusResult('error', { code: 'in_flight' }));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
  runtime.controllers.set(request.requestId, controller);
  try {
    const credential = await getCredential(transport);
    if (!credential) { rememberStatus('missing_key'); return bindingResult(request, statusResult('error', { code: 'missing_key' })); }
    const finalCheck = await finalDispatchCheck(task, transport);
    if (!finalCheck.ok) { rememberStatus(finalCheck.reason); return bindingResult(request, statusResult('error', { code: finalCheck.reason })); }
    const reservation = await reserveUsage(settings);
    if (!reservation.ok) { rememberStatus(reservation.error.code); return bindingResult(request, statusResult('error', reservation.error)); }
    const state = { site: task.site.id, post_text: request.postText, truncated: false };
    let body;
    if (transport.id === 'gateway') {
      body = await evaluateWithGateway({ apiKey: credential, model: transport.model, state, questions: buildQuestions(categories), signal: controller.signal });
    } else {
      const response = await fetch(transport.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: transport.model, state: JSON.stringify(state), questions: buildQuestions(categories) }),
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) {
        await pauseInference(authFailureMessage(response.status));
        return bindingResult(request, statusResult('error', { code: response.status === 401 ? 'unauthorized' : 'forbidden' }));
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await setCooldown('rate_limited', Number.isFinite(retryAfter) && retryAfter >= 1 ? retryAfter : 60);
        rememberStatus('rate_limited');
        return bindingResult(request, statusResult('error', { code: 'rate_limited' }));
      }
      if (response.status >= 500) { rememberStatus('server_error'); return bindingResult(request, statusResult('error', { code: 'server_error', detail: `http_${response.status}` })); }
      if (!response.ok) { rememberStatus('server_error'); return bindingResult(request, statusResult('error', { code: 'server_error', detail: `http_${response.status}` })); }
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > 1_048_576) { rememberStatus('invalid_response'); return bindingResult(request, statusResult('error', { code: 'invalid_response', detail: 'response_too_large' })); }
      const bodyText = await response.text();
      if (bodyText.length > 1_048_576) { rememberStatus('invalid_response'); return bindingResult(request, statusResult('error', { code: 'invalid_response', detail: 'response_too_large' })); }
      try { body = JSON.parse(bodyText); } catch {
        rememberStatus('invalid_response');
        return bindingResult(request, statusResult('error', { code: 'invalid_response', detail: 'invalid_json' }));
      }
    }
    const validated = validateJevResponse(body, categories);
    if (!validated.ok) { rememberStatus('invalid_response'); return bindingResult(request, statusResult('error', { code: 'invalid_response', detail: validated.error })); }
    if (validated.model && validated.model !== transport.model) { rememberStatus('invalid_response'); return bindingResult(request, statusResult('error', { code: 'invalid_response', detail: 'model_mismatch' })); }
    const result = { status: 'classified', transportId: settings.selectedTransport, modelIdentifier: transport.model, answers: validated.answers, usage: validated.usage };
    await putCache(cacheKey, result);
    if (currentSettings().revision !== settings.revision) return bindingResult(request, statusResult('error', { code: 'disabled' }));
    return bindingResult(request, result);
  } catch (error) {
    const status = gatewayErrorStatus(error);
    if (status === 401 || status === 403) {
      await pauseInference(authFailureMessage(status));
      return bindingResult(request, statusResult('error', { code: status === 401 ? 'unauthorized' : 'forbidden' }));
    }
    if (status === 429) {
      await setCooldown('rate_limited', 60);
      rememberStatus('rate_limited');
      return bindingResult(request, statusResult('error', { code: 'rate_limited' }));
    }
    const code = error?.name === 'AbortError' ? (controller.signal.reason === 'timeout' ? 'timeout' : 'disabled') : 'offline';
    if (code !== 'disabled') rememberStatus(code);
    return bindingResult(request, statusResult('error', { code }));
  } finally {
    clearTimeout(timeout);
    runtime.controllers.delete(request.requestId);
    await setLease(leaseKey, null);
  }
}

async function putCache(key, result) {
  const item = { expiresAt: Date.now() + CACHE_TTL_MS, result: { answers: clone(result.answers) } };
  runtime.cache.set(key, item);
  while (runtime.cache.size > CACHE_LIMIT) runtime.cache.delete(runtime.cache.keys().next().value);
  const serialized = Object.fromEntries([...runtime.cache].map(([cacheKey, value]) => [cacheKey, value]));
  await storageSet('session', { [CACHE_KEY]: serialized });
}

async function broadcast(message) {
  for (const tabId of runtime.connectedTabs.keys()) {
    try { await chrome.tabs.sendMessage(tabId, message); } catch { runtime.connectedTabs.delete(tabId); }
  }
}

async function saveSettingsUnlocked(message) {
  const current = currentSettings();
  if (message.expectedRevision !== current.revision) return { ok: false, error: redactedError('invalid_message', 'stale_settings') };
  const next = mergeSettings(current, message.patch);
  if (!next) return { ok: false, error: redactedError('invalid_message', 'settings') };
  const nextSites = new Map([...Object.values(BUILTIN_SITES), ...next.customSites].map(site => [site.id, site]));
  for (const site of [...Object.values(BUILTIN_SITES), ...current.customSites]) {
    const wasEnabled = Boolean(current.enabledSites[site.id] || site.enabled);
    const nextSite = nextSites.get(site.id);
    const remainsEnabled = Boolean(nextSite && (next.enabledSites[nextSite.id] || nextSite.enabled));
    if (wasEnabled && !remainsEnabled) {
      await unregisterSite(site.id);
      await removeInjectedStyles(site);
    }
  }
  const transportChanged = next.selectedTransport !== current.selectedTransport || next.model !== current.model;
  if (transportChanged) {
    for (const controller of runtime.controllers.values()) controller.abort();
    runtime.queue.splice(0).forEach(task => task.resolve(bindingResult(task.request, statusResult('error', { code: 'disabled' }))));
    runtime.cache.clear();
    await storageSet('session', { [CACHE_KEY]: {} });
  }
  runtime.settings = next;
  await storageSet('local', { [SETTINGS_KEY]: next });
  await reconcileRegistrations();
  await broadcast({ type: 'SETTINGS_CHANGED', settings: publicSettings(next) });
  return { ok: true, settings: publicSettings(next) };
}

async function saveSettings(message) {
  return serializedWrite(() => saveSettingsUnlocked(message));
}

async function pauseInference(message) {
  const statusMessage = typeof message === 'string' ? message : '';
  const next = mergeSettings(currentSettings(), pausePatch(true, statusMessage));
  if (!next) return { ok: false, error: redactedError('invalid_message', 'pause') };
  for (const controller of runtime.controllers.values()) controller.abort();
  runtime.queue.splice(0).forEach(task => task.resolve(bindingResult(task.request, statusResult('error', { code: 'paused' }))));
  runtime.settings = next;
  runtime.lastStatus = statusMessage;
  await storageSet('local', { [SETTINGS_KEY]: next });
  await broadcast({ type: 'SETTINGS_CHANGED', settings: publicSettings(next) });
  return { ok: true, settings: publicSettings(next) };
}

async function setPaused(message) {
  if (typeof message?.paused !== 'boolean') return { ok: false, error: redactedError('invalid_message', 'pause') };
  if (message.paused) return pauseInference('Inference is paused; posts remain visible.');
  const next = mergeSettings(currentSettings(), pausePatch(false));
  if (!next) return { ok: false, error: redactedError('invalid_message', 'pause') };
  runtime.settings = next;
  runtime.lastStatus = '';
  await storageSet('local', { [SETTINGS_KEY]: next });
  await broadcast({ type: 'SETTINGS_CHANGED', settings: publicSettings(next) });
  return { ok: true, settings: publicSettings(next) };
}

async function importSettingsMessage(message) {
  const current = currentSettings();
  if (message.expectedRevision !== current.revision) return { ok: false, error: redactedError('invalid_message', 'stale_settings') };
  const imported = importSettings(message.settings);
  if (!imported) return { ok: false, error: redactedError('invalid_message', 'settings') };
  return saveSettings({ expectedRevision: current.revision, patch: imported });
}

async function enableSite(message) {
  const current = currentSettings();
  const site = [...Object.values(BUILTIN_SITES), ...current.customSites].find(item => item.id === message.siteId);
  if (site && (!current.consentedOrigins.includes(site.origin) || !current.consentedRoutes.includes(current.selectedTransport)) && message.consent !== true) return { ok: false, error: redactedError('permission_denied', 'disclosure_required') };
  if (!site || !(await hasPermission(site.origin))) return { ok: false, error: redactedError('permission_denied', site?.origin ?? 'unknown_site') };
  const enabledSites = { ...current.enabledSites };
  const customSites = current.customSites.map(item => item.id === site.id ? { ...item, enabled: true } : item);
  if (Object.hasOwn(enabledSites, site.id)) enabledSites[site.id] = true;
  const next = mergeSettings(current, { enabledSites, customSites, consentedOrigins: [...new Set([...current.consentedOrigins, site.origin])], consentedRoutes: [...new Set([...current.consentedRoutes, current.selectedTransport])], statusMessage: '' });
  if (!next) return { ok: false, error: redactedError('invalid_message', 'settings') };
  runtime.settings = next;
  await storageSet('local', { [SETTINGS_KEY]: next });
  await registerSite(site);
  await injectExistingTabs(site);
  await broadcast({ type: 'SETTINGS_CHANGED', settings: publicSettings(next) });
  return { ok: true, settings: publicSettings(next) };
}

async function disableSite(message) {
  const current = currentSettings();
  const site = [...Object.values(BUILTIN_SITES), ...current.customSites].find(item => item.id === message.siteId);
  if (!site) return { ok: false, error: redactedError('invalid_message', 'unknown_site') };
  const next = mergeSettings(current, {
    enabledSites: { ...current.enabledSites, ...(Object.hasOwn(current.enabledSites, site.id) ? { [site.id]: false } : {}) },
    customSites: current.customSites.map(item => item.id === site.id ? { ...item, enabled: false } : item)
  });
  runtime.settings = next;
  await storageSet('local', { [SETTINGS_KEY]: next });
  await unregisterSite(site.id);
  await removeInjectedStyles(site);
  await broadcast({ type: 'TEARDOWN', reason: 'disabled', siteId: site.id });
  await broadcast({ type: 'SETTINGS_CHANGED', settings: publicSettings(next) });
  return { ok: true, settings: publicSettings(next) };
}

async function statusForSender(sender, message) {
  const settings = currentSettings();
  let tab;
  if (sender.tab?.id >= 0) tab = sender.tab;
  else if (Number.isInteger(message?.tabId) && message.tabId >= 0) {
    try { tab = await chrome.tabs.get(message.tabId); } catch { tab = undefined; }
  }
  const url = tab?.url ?? '';
  const site = siteForUrl(url, settings);
  const local = await storageGet('local', [USAGE_KEY, COOLDOWN_KEY]);
  const usage = usageForToday(local[USAGE_KEY]);
    return {
    ok: true,
    site: site?.id ?? null,
    enabled: Boolean(site),
    settings: publicSettings(settings),
    pending: tab?.id == null ? 0 : tabPendingCount(tab.id),
    usage,
    cooldown: local[COOLDOWN_KEY]?.until > Date.now() ? local[COOLDOWN_KEY] : null,
    cacheHits: runtime.cacheHits,
    statusMessage: runtime.lastStatus || settings.statusMessage
  };
}

async function setCredential(message) {
  const transport = TRANSPORTS[message.transport];
  if (!transport || typeof message.key !== 'string' || message.key.length < 8 || message.key.length > 500 || /\s/u.test(message.key)) return { ok: false, error: redactedError('invalid_message', 'credential') };
  await storageSet('session', { [`${KEY_PREFIX}${transport.id}`]: message.key });
  runtime.lastStatus = '';
  const next = mergeSettings(currentSettings(), { inferencePaused: false, statusMessage: '' });
  runtime.settings = next;
  await storageSet('local', { [SETTINGS_KEY]: next });
  return { ok: true };
}

async function handleMessage(message, sender) {
  await initialize();
  if (!message || typeof message.type !== 'string') return { ok: false, error: redactedError('invalid_message') };
  if (message.type === 'CLASSIFY_REQUEST') return handleClassify(message, sender);
  if (message.type === 'CONTENT_READY') {
    if (!isContentSender(sender)) return { ok: false, error: redactedError('invalid_message') };
    runtime.connectedTabs.set(sender.tab.id, Date.now());
    const site = siteForUrl(sender.tab.url, currentSettings());
    return { ok: true, enabled: Boolean(site), settings: site ? publicSettings(currentSettings()) : null };
  }
  if (message.type === 'GET_EFFECTIVE_SETTINGS') {
    if (!isContentSender(sender)) return { ok: false, error: redactedError('invalid_message') };
    const site = siteForUrl(sender.tab.url, currentSettings());
    return { ok: true, settings: site ? publicSettings(currentSettings()) : null };
  }
  if (!isExtensionSender(sender)) return { ok: false, error: redactedError('invalid_message') };
  if (message.type === 'GET_SETTINGS') return { ok: true, settings: publicSettings(currentSettings()) };
  if (message.type === 'EXPORT_SETTINGS') return { ok: true, settings: exportableSettings(currentSettings()) };
  if (message.type === 'GET_STATUS') return statusForSender(sender, message);
  if (message.type === 'SAVE_SETTINGS') return saveSettings(message);
  if (message.type === 'IMPORT_SETTINGS') return importSettingsMessage(message);
  if (message.type === 'PAUSE_INFERENCE') return setPaused(message);
  if (message.type === 'SET_CREDENTIAL') return setCredential(message);
  if (message.type === 'ENABLE_SITE') return enableSite(message);
  if (message.type === 'DISABLE_SITE') return disableSite(message);
  if (message.type === 'RECONCILE') { await reconcileRegistrations(); return { ok: true }; }
  return { ok: false, error: redactedError('invalid_message', 'unknown_type') };
}

function boot() {
  const report = context => error => console.error(`Unslopify ${context} failed:`, error);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: redactedError('server_error', error.message) }));
    return true;
  });
  chrome.runtime.onStartup.addListener(() => { initialize().catch(report('startup')); });
  chrome.runtime.onInstalled.addListener(() => { initialize().catch(report('installation')); });
  chrome.permissions.onRemoved.addListener(({ origins = [] }) => {
    initialize().then(async () => {
      for (const site of [...Object.values(BUILTIN_SITES), ...runtime.settings.customSites]) {
        const enabled = Boolean(runtime.settings.enabledSites[site.id] || site.enabled);
        if (enabled && (origins.includes(originPermission(site.origin)) || !(await hasPermission(site.origin)))) {
          await unregisterSite(site.id);
          await removeInjectedStyles(site);
          await disableSiteWithoutPermission(site.id);
          await broadcast({ type: 'TEARDOWN', reason: 'permission_removed', siteId: site.id });
          await broadcast({ type: 'SETTINGS_CHANGED', settings: publicSettings(runtime.settings) });
        }
      }
    }).catch(report('permission reconciliation'));
  });
  initialize().catch(report('initialization'));
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) boot();

export { handleClassify, handleMessage, validateContentRequest, reserveUsage };
