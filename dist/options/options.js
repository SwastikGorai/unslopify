import { BUILTIN_SITES, CATEGORY_DEFINITIONS, DISPLAY_MODES, MAX_EXAMPLE_LENGTH, MAX_EXAMPLES_PER_OUTCOME, TRANSPORTS } from '../shared/contracts.js';
import { isSettingsReady, messageFailure, needsCredential, responseDetail } from './state.js';

let settings = null;
let credentials = {};
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

function setStatus(text, error = false, node = $('#status')) {
  node.textContent = text;
  node.dataset.error = error ? 'true' : 'false';
}

const siteStatus = siteId => $(`[data-site-status="${siteId}"]`);

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
    mode.dataset.siteMode = site.id;
    mode.setAttribute('aria-label', `${site.label} display mode`);
    for (const value of DISPLAY_MODES) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = { label: 'Label', 'overlay-low': 'Low blur', 'overlay-high': 'High blur', collapse: 'Collapse' }[value];
      option.selected = (settings.siteModes?.[site.id] || settings.mode) === value;
      mode.append(option);
    }
    const sensitivity = document.createElement('input');
    sensitivity.dataset.siteThreshold = site.id;
    sensitivity.type = 'number';
    sensitivity.min = '0';
    sensitivity.max = '1';
    sensitivity.step = '0.01';
    sensitivity.value = settings.siteThresholds?.[site.id]?.presentProbability ?? settings.thresholds.presentProbability;
    sensitivity.title = 'Present probability threshold';
    sensitivity.setAttribute('aria-label', `${site.label} present probability threshold`);
    const status = document.createElement('span');
    status.className = 'action-status';
    status.dataset.siteStatus = site.id;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    actions.append(state, mode, sensitivity, enable, disable, status);
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
    remove.addEventListener('click', () => savePatch({ customSites: settings.customSites.filter(item => item.id !== site.id) }, $('#custom-status')));
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.textContent = 'Preview';
    preview.addEventListener('click', () => previewSite(site));
    row.append(text, preview, remove);
    custom.append(row);
  }
}

async function previewSite(site) {
  const status = $('#custom-status');
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const tab = tabs.find(candidate => candidate.url?.startsWith(`${site.origin}/`));
  if (!tab?.id) { setStatus('No active tab to preview.', true, status); return; }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'PREVIEW_RULE', rule: site });
    if (!result?.ok) { setStatus(`Preview unavailable: ${result?.error || 'enable this rule on the active tab first'}`, true, status); return; }
    $('#preview-output').textContent = result.samples.join('\n\n') || 'No unambiguous body text found.';
    setStatus(`Preview found ${result.count} cards locally (${result.ambiguous || 0} ambiguous); highlighted matches for five seconds. No Jev call was made.`, false, status);
  } catch { setStatus('Preview requires an enabled rule on the active tab.', true, status); }
}

function render() {
  $$('input[name="transport"]').forEach(input => { input.checked = input.value === settings.selectedTransport; });
  $$('input[data-category]').forEach(input => { input.checked = settings.categoryToggles[input.dataset.category] === true; });
  $$('input[name="mode"]').forEach(input => { input.checked = input.value === settings.mode; });
  $$('input[name="overlay-tint"]').forEach(input => { input.checked = input.value === settings.overlayTint; });
  $('#probability').value = settings.thresholds.presentProbability;
  $('#confidence').value = settings.thresholds.confidence;
  $('#allowlist').value = settings.allowlist.join('\n');
  $('#batch-size').value = settings.batchSize;
  const transport = $$('input[name="transport"]').find(input => input.checked)?.value || settings.selectedTransport;
  $('#remember-key').checked = credentials[transport]?.remembered === true;
  renderExamples();
  renderSites();
  disclosure();
}

function renderExamples() {
  const container = $('#category-examples');
  container.replaceChildren();
  for (const [id, definition] of Object.entries(CATEGORY_DEFINITIONS)) {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = definition.label;
    fieldset.append(legend);
    for (const [outcome, label] of [['present', 'Should be filtered'], ['absent', 'Should be allowed']]) {
      const wrapper = document.createElement('label');
      wrapper.textContent = label;
      const textarea = document.createElement('textarea');
      textarea.rows = 4;
      textarea.spellcheck = false;
      textarea.dataset.exampleCategory = id;
      textarea.dataset.exampleOutcome = outcome;
      textarea.value = settings.categoryExamples[id][outcome].join('\n');
      wrapper.append(textarea);
      fieldset.append(wrapper);
    }
    container.append(fieldset);
  }
}

async function savePatch(patch, status = $('#status')) {
  if (!requireSettings()) return false;
  try {
    const response = await message({ type: 'SAVE_SETTINGS', expectedRevision: settings.revision, patch });
    if (!response?.ok) { setStatus(`Could not save settings: ${responseDetail(response, 'stale settings')}`, true, status); return false; }
    if (!isSettingsReady(response.settings)) { setStatus('Could not save settings: service worker returned invalid settings.', true, status); return false; }
    settings = response.settings;
    render();
    setStatus('Settings saved.', false, status);
    return true;
  } catch (error) {
    setStatus(`Could not save settings: ${messageFailure(error, 'SAVE_SETTINGS')}`, true, status);
    return false;
  }
}

async function enableSite(site) {
  if (!requireSettings()) return;
  const report = (text, error = false) => setStatus(text, error, siteStatus(site.id));
  const route = $$('input[name="transport"]').find(input => input.checked)?.value || settings.selectedTransport;
  if (!$('#consent').checked && (!settings.consentedOrigins.includes(site.origin) || !settings.consentedRoutes.includes(route))) { report('Review the recipient disclosure and confirm it before enabling this site.', true); return; }
  let granted;
  try { granted = await chrome.permissions.request({ origins: [`${site.origin}/*`] }); }
  catch (error) { report(`Could not request permission: ${error.message}`, true); return; }
  if (!granted) { report(`Permission was not granted for ${site.origin}.`, true); return; }
  try {
    const response = await message({ type: 'ENABLE_SITE', siteId: site.id, consent: true });
    if (!response?.ok) { report(`Could not enable ${site.label}: ${responseDetail(response, 'permission denied')}`, true); return; }
    if (!isSettingsReady(response.settings)) { report(`Could not enable ${site.label}: service worker returned invalid settings.`, true); return; }
    settings = response.settings;
    render();
    report(`${site.label} enabled. Reload an existing tab if it was already open.`);
  } catch (error) {
    report(`Could not enable ${site.label}: ${messageFailure(error, 'ENABLE_SITE')}`, true);
  }
}

async function disableSite(site) {
  if (!requireSettings()) return;
  const report = (text, error = false) => setStatus(text, error, siteStatus(site.id));
  try {
    const response = await message({ type: 'DISABLE_SITE', siteId: site.id });
    if (!response?.ok) { report(`Could not disable ${site.label}: ${responseDetail(response, 'permission denied')}`, true); return; }
    if (!isSettingsReady(response.settings)) { report(`Could not disable ${site.label}: service worker returned invalid settings.`, true); return; }
    settings = response.settings;
    render();
    report(`${site.label} disabled and existing labels removed where reachable.`);
  } catch (error) {
    report(`Could not disable ${site.label}: ${messageFailure(error, 'DISABLE_SITE')}`, true);
  }
}

function collectExamples() {
  const result = Object.fromEntries(Object.keys(CATEGORY_DEFINITIONS).map(id => [id, { present: [], absent: [] }]));
  for (const textarea of $$('textarea[data-example-category]')) {
    const examples = textarea.value.split('\n').map(value => value.replace(/\s+/gu, ' ').trim()).filter(Boolean);
    if (examples.length > MAX_EXAMPLES_PER_OUTCOME || examples.some(example => example.length > MAX_EXAMPLE_LENGTH)) throw new Error(`Use at most ${MAX_EXAMPLES_PER_OUTCOME} examples of ${MAX_EXAMPLE_LENGTH} characters per field.`);
    result[textarea.dataset.exampleCategory][textarea.dataset.exampleOutcome] = [...new Set(examples)];
  }
  return result;
}

async function applySettings() {
  if (!requireSettings()) return;
  const mode = $$('input[name="mode"]').find(input => input.checked)?.value || 'label';
  const selectedTransport = $$('input[name="transport"]').find(input => input.checked)?.value || settings.selectedTransport;
  const apiKey = $('#api-key');
  const key = apiKey.value.trim();
  if (needsCredential(key, credentials[selectedTransport])) {
    apiKey.setAttribute('aria-invalid', 'true');
    apiKey.focus();
    setStatus(`Enter a ${TRANSPORTS[selectedTransport].credentialName} before applying settings.`, true);
    return;
  }
  apiKey.removeAttribute('aria-invalid');
  if (!$('#consent').checked && selectedTransport !== settings.selectedTransport) { setStatus('Review the updated recipient disclosure before switching routes.', true); return; }
  if (selectedTransport === 'direct' && settings.selectedTransport !== 'direct') {
    let granted;
    try { granted = await chrome.permissions.request({ origins: [`${TRANSPORTS.direct.origin}/*`] }); }
    catch (error) { setStatus(`Could not request direct TypeSafe permission: ${error.message}`, true); return; }
    if (!granted) { setStatus('Direct TypeSafe permission was not granted.', true); return; }
  }
  let categoryExamples;
  try { categoryExamples = collectExamples(); }
  catch (error) { setStatus(error.message, true); return; }
  const patch = {
    selectedTransport,
    categoryToggles: Object.fromEntries($$('input[data-category]').map(input => [input.dataset.category, input.checked])),
    categoryExamples,
    batchSize: Number($('#batch-size').value),
    mode,
    overlayTint: $$('input[name="overlay-tint"]').find(input => input.checked)?.value || settings.overlayTint,
    siteModes: Object.fromEntries($$('select[data-site-mode]').map(input => [input.dataset.siteMode, input.value])),
    siteThresholds: Object.fromEntries($$('input[data-site-threshold]').map(input => [input.dataset.siteThreshold, { ...(settings.siteThresholds?.[input.dataset.siteThreshold] || settings.thresholds), presentProbability: Number(input.value) }])),
    allowlist: $('#allowlist').value.split('\n').map(value => value.trim()).filter(Boolean),
    consentedRoutes: $('#consent').checked ? [...new Set([...(settings.consentedRoutes || []), selectedTransport])] : settings.consentedRoutes,
    thresholds: {
      presentProbability: Number($('#probability').value),
      confidence: Number($('#confidence').value)
    }
  };
  try {
    const response = await message({
      type: 'APPLY_OPTIONS',
      expectedRevision: settings.revision,
      patch,
      credential: { transport: selectedTransport, key, remember: $('#remember-key').checked }
    });
    if (!response?.ok) { setStatus(`Could not apply settings: ${responseDetail(response, 'stale settings')}`, true); return; }
    if (!isSettingsReady(response.settings)) { setStatus('Could not apply settings: service worker returned invalid settings.', true); return; }
    settings = response.settings;
    credentials = response.credentials || credentials;
    $('#api-key').value = '';
    render();
    setStatus('Settings applied.');
  } catch (error) {
    setStatus(`Could not apply settings: ${messageFailure(error, 'APPLY_OPTIONS')}`, true);
  }
}

function downloadSettings() {
  if (!requireSettings()) return;
  const status = $('#transfer-status');
  message({ type: 'EXPORT_SETTINGS' }).then(response => {
    if (!response?.ok) { setStatus(`Could not export settings: ${responseDetail(response, 'export failed')}`, true, status); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(response.settings, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'unslopify-settings.json';
    link.click();
    URL.revokeObjectURL(url);
    setStatus('Exported non-secret settings; imported rules start disabled.', false, status);
  }).catch(error => setStatus(`Could not export settings: ${messageFailure(error, 'EXPORT_SETTINGS')}`, true, status));
}

async function importSettings(event) {
  if (!requireSettings()) return;
  const status = $('#transfer-status');
  const file = event.target.files?.[0];
  if (!file || file.size > 256 * 1024) { setStatus('Import is too large.', true, status); return; }
  let imported;
  try {
    imported = JSON.parse(await file.text());
  } catch {
    setStatus('Import is not valid JSON.', true, status);
    return;
  }
  try {
    const response = await message({ type: 'IMPORT_SETTINGS', expectedRevision: settings.revision, settings: imported });
    if (!response?.ok) { setStatus(`Could not import settings: ${responseDetail(response, 'invalid file')}`, true, status); return; }
    if (!isSettingsReady(response.settings)) { setStatus('Could not import settings: service worker returned invalid settings.', true, status); return; }
    settings = response.settings;
    render();
    setStatus('Imported settings are disabled until each site is enabled again.', false, status);
  } catch (error) {
    setStatus(`Could not import settings: ${messageFailure(error, 'IMPORT_SETTINGS')}`, true, status);
  }
}

async function addCustom() {
  if (!requireSettings()) return;
  const status = $('#custom-status');
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
  if (await savePatch({ customSites: [...settings.customSites.filter(site => site.id !== rule.id), rule] }, status)) {
    if (!settings.customSites.some(site => site.id === rule.id)) { setStatus('Custom rule is invalid; check its ID, HTTPS origin, paths, and selectors.', true, status); return; }
    ['custom-id', 'custom-label', 'custom-origin', 'custom-root', 'custom-post', 'custom-body', 'custom-permalink'].forEach(id => { $(`#${id}`).value = ''; });
  }
}

async function load() {
  try {
    const response = await message({ type: 'GET_SETTINGS' });
    if (!response?.ok) { setStatus(`Could not load settings: ${responseDetail(response, 'worker rejected the request')}`, true); return; }
    if (!isSettingsReady(response.settings)) { setStatus('Could not load settings: service worker returned invalid settings.', true); return; }
    settings = response.settings;
    credentials = response.credentials || {};
    render();
  } catch (error) {
    settings = null;
    setStatus(`Could not load settings: ${messageFailure(error, 'GET_SETTINGS')}`, true);
  }
}

$$('input[name="transport"]').forEach(input => input.addEventListener('change', () => {
  $('#consent').checked = false;
  $('#remember-key').checked = credentials[input.value]?.remembered === true;
  disclosure();
}));
$('#apply-settings').addEventListener('click', applySettings);
$('#add-custom').addEventListener('click', addCustom);
$('#export-settings').addEventListener('click', downloadSettings);
$('#import-settings').addEventListener('change', importSettings);
load();
