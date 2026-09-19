import { BUILTIN_SITES } from '../shared/contracts.js';

const $ = selector => document.querySelector(selector);

async function load() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS', tabId: tab?.id });
  if (!response?.ok) { $('#status').textContent = 'Status unavailable.'; return; }
  const site = response.site ? [...Object.values(BUILTIN_SITES), ...(response.settings.customSites || [])].find(item => item.id === response.site) : null;
  $('#site').textContent = site ? `${site.label}: ${response.enabled ? 'enabled' : 'disabled'}` : 'No supported enabled feed in this tab.';
  const siteMode = site ? (response.settings.siteModes?.[site.id] || response.settings.mode) : response.settings.mode;
  $('#mode').textContent = siteMode === 'collapse' ? 'Mode: collapse with reveal' : 'Mode: label only';
  $('#status').textContent = response.statusMessage || response.settings.statusMessage || (response.cooldown ? 'Inference is cooling down; posts remain visible.' : `${response.pending} pending request${response.pending === 1 ? '' : 's'}.`);
  $('#usage').textContent = `Today: ${response.usage?.dayAttempts || 0} attempts · ${response.cacheHits || 0} cache hits`;
  $('#pause').textContent = response.settings.inferencePaused ? 'Resume inference' : 'Pause inference';
  $('#pause').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'PAUSE_INFERENCE', paused: !response.settings.inferencePaused });
    load();
  };
}

$('#options').addEventListener('click', () => chrome.runtime.openOptionsPage());
load().catch(() => { $('#status').textContent = 'Status unavailable.'; });
