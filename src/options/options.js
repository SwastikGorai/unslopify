import { BUILTIN_SITES, TRANSPORTS } from '../shared/contracts.js';
import { isSettingsReady, messageFailure, responseDetail } from './state.js';

let settings = null;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function message(payload) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(payload, response => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
        } else if (response === undefined) {
          reject(new Error('No response from the extension service worker.'));
        } else {
          resolve(response);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

function setStatus(text, error = false) {
  const node = $('#status');
  node.textContent = text;
  node.dataset.error = error ? 'true' : 'false';
}

function disclosure() {
  const transport = TRANSPORTS[$$('input[name="transport"]').find(input => input.checked)?.value || 'gateway'];
  $('#disclosure').textContent = `Selected feed text is sent to ${transport.label} and ${transport.id === 'gateway' ? 'TypeSafe through Vercel AI Gateway' : 'TypeSafe directly'} for a typed decision. Provider retention and logging are governed by their current terms; zero retention is not assumed.`;
}

function requireSettings() {
  if (isSettingsReady(settings)) return true;
  setStatus('Settings are not loaded; reload this page and try again.', true);
  return false;
}

function renderSites() {
  const container = $('#sites');
  container.replaceChildren();
  const sites = [...Object.values(BUILTIN_SITES), ...settings.customSites];
  for (const site of sites) {
    const enabled = Boolean(settings.enabledSites[site.id] || site.enabled);
    const row = document.createElement('div');
    row.className = 'site-row';
    const label = document.createElement('span');
    label.textContent = `${site.label} (${site.origin})`;
    const actions = document.createElement('span');
    actions.className = 'site-actions';
    const state = document.createElement('span');
    state.className = 'muted';
    state.textContent = enabled ? 'Enabled' : 'Disabled';
    const enable = document.createElement('button');
    enable.type = 'button';
    enable.textContent = enabled ? 'Enabled' : 'Enable';
    enable.disabled = enabled;
    enable.addEventListener('click', () => enableSite(site));
    const disable = document.createElement('button');
    disable.type = 'button';
    disable.textContent = 'Disable';
    disable.disabled = !enabled;
    disable.addEventListener('click', () => disableSite(site));
    const mode = document.createElement('select');
    mode.setAttribute('aria-label', `${site.label} display mode`);
    for (const value of ['label', 'overlay', 'collapse']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value === 'collapse' ? 'Collapse' : value === 'overlay' ? 'Translucent banner' : 'Label';
      option.selected = (settings.siteModes?.[site.id] || settings.mode) === value;
      mode.append(option);
    }
    mode.addEventListener('change', () => savePatch({ siteModes: { ...settings.siteModes, [site.id]: mode.value } }));
    const sensitivity = document.createElement('input');
    sensitivity.type = 'number';
    sensitivity.min = '0';
    sensitivity.max = '1';
    sensitivity.step = '0.01';
    sensitivity.value = settings.siteThresholds?.[site.id]?.presentProbability ?? settings.thresholds.presentProbability;
    sensitivity.title = 'Present probability threshold';
    sensitivity.setAttribute('aria-label', `${site.label} present probability threshold`);
    sensitivity.addEventListener('change', () => savePatch({ siteThresholds: { ...settings.siteThresholds, [site.id]: { ...(settings.siteThresholds?.[site.id] || settings.thresholds), presentProbability: Number(sensitivity.value) } } }));
    actions.append(state, mode, sensitivity, enable, disable);
    row.append(label, actions);
    container.append(row);
  }
  const custom = $('#custom-rules');
  custom.replaceChildren();
  for (const site of settings.customSites) {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const text = document.createElement('span');
    text.textContent = `${site.label}: ${site.origin}${site.paths[0]}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => savePatch({ customSites: settings.customSites.filter(item => item.id !== site.id) }));
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.textContent = 'Preview';
    preview.addEventListener('click', () => previewSite(site));
    row.append(text, preview, remove);
    custom.append(row);
  }
}

async function previewSite(site) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const tab = tabs.find(candidate => candidate.url?.startsWith(`${site.origin}/`));
  if (!tab?.id) { setStatus('No active tab to preview.', true); return; }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'PREVIEW_RULE', rule: site });
    if (!result?.ok) { setStatus(`Preview unavailable: ${result?.error || 'enable this rule on the active tab first'}`, true); return; }
    $('#preview-output').textContent = result.samples.join('\n\n') || 'No unambiguous body text found.';
    setStatus(`Preview found ${result.count} cards locally (${result.ambiguous || 0} ambiguous); highlighted matches for five seconds. No Jev call was made.`);
  } catch { setStatus('Preview requires an enabled rule on the active tab.', true); }
}

function render() {
  $$('input[name="transport"]').forEach(input => { input.checked = input.value === settings.selectedTransport; });
  $$('input[data-category]').forEach(input => { input.checked = settings.categoryToggles[input.dataset.category] === true; });
  $$('input[name="mode"]').forEach(input => { input.checked = input.value === settings.mode; });
  $('#probability').value = settings.thresholds.presentProbability;
  $('#confidence').value = settings.thresholds.confidence;
  $('#allowlist').value = settings.allowlist.join('\n');
  renderSites();
  disclosure();
}

async function savePatch(patch) {
  if (!requireSettings()) return false;
  try {
    const response = await message({ type: 'SAVE_SETTINGS', expectedRevision: settings.revision, patch });
    if (!response?.ok) { setStatus(`Could not save settings: ${responseDetail(response, 'stale settings')}`, true); return false; }
    if (!isSettingsReady(response.settings)) { setStatus('Could not save settings: service worker returned invalid settings.', true); return false; }
    settings = response.settings;
    render();
    setStatus('Settings saved.');
    return true;
  } catch (error) {
    setStatus(`Could not save settings: ${messageFailure(error, 'SAVE_SETTINGS')}`, true);
    return false;
  }
}

async function enableSite(site) {
  if (!requireSettings()) return;
  const route = $$('input[name="transport"]').find(input => input.checked)?.value || settings.selectedTransport;
  if (!$('#consent').checked && (!settings.consentedOrigins.includes(site.origin) || !settings.consentedRoutes.includes(route))) { setStatus('Review the recipient disclosure and confirm it before enabling a site.', true); return; }
  let granted;
  try { granted = await chrome.permissions.request({ origins: [`${site.origin}/*`] }); }
  catch (error) { setStatus(`Could not request permission: ${error.message}`, true); return; }
  if (!granted) { setStatus(`Permission was not granted for ${site.origin}.`, true); return; }
  try {
    const response = await message({ type: 'ENABLE_SITE', siteId: site.id, consent: true });
    if (!response?.ok) { setStatus(`Could not enable ${site.label}: ${responseDetail(response, 'permission denied')}`, true); return; }
    if (!isSettingsReady(response.settings)) { setStatus(`Could not enable ${site.label}: service worker returned invalid settings.`, true); return; }
    settings = response.settings;
    render();
    setStatus(`${site.label} enabled. Reload an existing tab if it was already open.`);
  } catch (error) {
    setStatus(`Could not enable ${site.label}: ${messageFailure(error, 'ENABLE_SITE')}`, true);
  }
}

async function disableSite(site) {
  if (!requireSettings()) return;
  try {
    const response = await message({ type: 'DISABLE_SITE', siteId: site.id });
    if (!response?.ok) { setStatus(`Could not disable ${site.label}: ${responseDetail(response, 'permission denied')}`, true); return; }
    if (!isSettingsReady(response.settings)) { setStatus(`Could not disable ${site.label}: service worker returned invalid settings.`, true); return; }
    settings = response.settings;
    render();
    setStatus(`${site.label} disabled and existing labels removed where reachable.`);
  } catch (error) {
    setStatus(`Could not disable ${site.label}: ${messageFailure(error, 'DISABLE_SITE')}`, true);
  }
}

async function saveKey() {
  if (!requireSettings()) return;
  const key = $('#api-key').value.trim();
  const transport = $$('input[name="transport"]').find(input => input.checked)?.value || settings.selectedTransport;
  if (!key) { setStatus('Enter a key before saving.', true); return; }
  if (transport === 'direct') {
    let granted;
    try { granted = await chrome.permissions.request({ origins: [`${TRANSPORTS.direct.origin}/*`] }); }
    catch (error) { setStatus(`Could not request direct TypeSafe permission: ${error.message}`, true); return; }
    if (!granted) { setStatus('Direct TypeSafe permission was not granted.', true); return; }
  }
  try {
    const response = await message({ type: 'SET_CREDENTIAL', transport, key });
    if (!response?.ok) { setStatus(`Could not save key: ${responseDetail(response, 'invalid key')}`, true); return; }
    $('#api-key').value = '';
    setStatus('Key saved in restricted session storage.');
  } catch (error) {
    setStatus(`Could not save key: ${messageFailure(error, 'SET_CREDENTIAL')}`, true);
  }
}

async function saveSettings() {
  if (!requireSettings()) return;
  const mode = $$('input[name="mode"]').find(input => input.checked)?.value || 'label';
  const selectedTransport = $$('input[name="transport"]').find(input => input.checked)?.value || settings.selectedTransport;
  if (!$('#consent').checked && selectedTransport !== settings.selectedTransport) { setStatus('Review the updated recipient disclosure before switching routes.', true); return; }
  if (selectedTransport === 'direct' && settings.selectedTransport !== 'direct') {
    let granted;
    try { granted = await chrome.permissions.request({ origins: [`${TRANSPORTS.direct.origin}/*`] }); }
    catch (error) { setStatus(`Could not request direct TypeSafe permission: ${error.message}`, true); return; }
    if (!granted) { setStatus('Direct TypeSafe permission was not granted.', true); return; }
  }
  const patch = {
    selectedTransport,
    categoryToggles: Object.fromEntries($$('input[data-category]').map(input => [input.dataset.category, input.checked])),
    mode,
    consentedRoutes: $('#consent').checked ? [...new Set([...(settings.consentedRoutes || []), selectedTransport])] : settings.consentedRoutes,
    thresholds: {
      presentProbability: Number($('#probability').value),
      confidence: Number($('#confidence').value)
    }
  };
  await savePatch(patch);
}

async function saveAllowlist() {
  if (!requireSettings()) return;
  const allowlist = $('#allowlist').value.split('\n').map(value => value.trim()).filter(Boolean);
  await savePatch({ allowlist });
}

function downloadSettings() {
  if (!requireSettings()) return;
  message({ type: 'EXPORT_SETTINGS' }).then(response => {
    if (!response?.ok) { setStatus(`Could not export settings: ${responseDetail(response, 'export failed')}`, true); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(response.settings, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'unslopify-settings.json';
    link.click();
    URL.revokeObjectURL(url);
    setStatus('Exported non-secret settings; imported rules start disabled.');
  }).catch(error => setStatus(`Could not export settings: ${messageFailure(error, 'EXPORT_SETTINGS')}`, true));
}

async function importSettings(event) {
  if (!requireSettings()) return;
  const file = event.target.files?.[0];
  if (!file || file.size > 256 * 1024) { setStatus('Import is too large.', true); return; }
  let imported;
  try {
    imported = JSON.parse(await file.text());
  } catch {
    setStatus('Import is not valid JSON.', true);
    return;
  }
  try {
    const response = await message({ type: 'IMPORT_SETTINGS', expectedRevision: settings.revision, settings: imported });
    if (!response?.ok) { setStatus(`Could not import settings: ${responseDetail(response, 'invalid file')}`, true); return; }
    if (!isSettingsReady(response.settings)) { setStatus('Could not import settings: service worker returned invalid settings.', true); return; }
    settings = response.settings;
    render();
    setStatus('Imported settings are disabled until each site is enabled again.');
  } catch (error) {
    setStatus(`Could not import settings: ${messageFailure(error, 'IMPORT_SETTINGS')}`, true);
  }
}

async function addCustom() {
  if (!requireSettings()) return;
  const rule = {
    id: $('#custom-id').value.trim(),
    label: $('#custom-label').value.trim(),
    origin: $('#custom-origin').value.trim().replace(/\/$/u, ''),
    paths: [$('#custom-path').value.trim()],
    feedRootSelector: $('#custom-root').value.trim(),
    postSelector: $('#custom-post').value.trim(),
    bodySelector: $('#custom-body').value.trim(),
    permalinkSelector: $('#custom-permalink').value.trim(),
    extractionVersion: 'custom-1',
    enabled: false
  };
  if (await savePatch({ customSites: [...settings.customSites.filter(site => site.id !== rule.id), rule] })) {
    if (!settings.customSites.some(site => site.id === rule.id)) { setStatus('Custom rule is invalid; check its ID, HTTPS origin, paths, and selectors.', true); return; }
    ['custom-id', 'custom-label', 'custom-origin', 'custom-root', 'custom-post', 'custom-body', 'custom-permalink'].forEach(id => { $(`#${id}`).value = ''; });
  }
}

async function load() {
  try {
    const response = await message({ type: 'GET_SETTINGS' });
    if (!response?.ok) { setStatus(`Could not load settings: ${responseDetail(response, 'worker rejected the request')}`, true); return; }
    if (!isSettingsReady(response.settings)) { setStatus('Could not load settings: service worker returned invalid settings.', true); return; }
    settings = response.settings;
    render();
  } catch (error) {
    settings = null;
    setStatus(`Could not load settings: ${messageFailure(error, 'GET_SETTINGS')}`, true);
  }
}

$$('input[name="transport"]').forEach(input => input.addEventListener('change', () => { $('#consent').checked = false; disclosure(); }));
$('#save-key').addEventListener('click', saveKey);
$('#save-settings').addEventListener('click', saveSettings);
$('#save-allowlist').addEventListener('click', saveAllowlist);
$('#add-custom').addEventListener('click', addCustom);
$('#export-settings').addEventListener('click', downloadSettings);
$('#import-settings').addEventListener('change', importSettings);
load();
