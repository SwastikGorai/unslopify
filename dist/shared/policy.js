import { DISPLAY_MODES, classifyGate, modeForSite, thresholdsForSite } from './contracts.js';

export function evaluatePolicy({ settings, answers, postId, siteId }) {
  if (!settings || !DISPLAY_MODES.includes(modeForSite(settings, siteId))) return { visible: true, categories: [] };
  if (settings.allowlist.includes(postId)) return { visible: true, categories: [] };
  const thresholds = thresholdsForSite(settings, siteId);
  const categories = Object.entries(answers ?? {})
    .filter(([id, answer]) => settings.categoryToggles[id] && classifyGate(answer, thresholds))
    .map(([id]) => id);
  return { visible: true, categories, qualifies: categories.length > 0 };
}

export function labelForCategory(id, definitions) {
  return definitions[id]?.label ? `Filtered: ${definitions[id].label}` : 'Filtered: low-value pattern';
}
