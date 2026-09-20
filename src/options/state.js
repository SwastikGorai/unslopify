export function isSettingsReady(settings) {
  return Boolean(
    settings && typeof settings === 'object'
    && Number.isInteger(settings.revision) && settings.revision >= 1
    && typeof settings.selectedTransport === 'string'
    && settings.enabledSites && typeof settings.enabledSites === 'object'
    && settings.siteModes && typeof settings.siteModes === 'object'
    && Array.isArray(settings.customSites)
    && settings.categoryToggles && typeof settings.categoryToggles === 'object'
    && settings.categoryExamples && typeof settings.categoryExamples === 'object'
    && Number.isInteger(settings.batchSize) && settings.batchSize >= 1 && settings.batchSize <= 10
    && settings.thresholds && typeof settings.thresholds.presentProbability === 'number' && typeof settings.thresholds.confidence === 'number'
    && settings.siteThresholds && typeof settings.siteThresholds === 'object'
    && typeof settings.mode === 'string' && Array.isArray(settings.allowlist)
    && Array.isArray(settings.consentedOrigins) && Array.isArray(settings.consentedRoutes)
  );
}

export function responseDetail(response, fallback) {
  return String(response?.error?.detail || response?.error?.code || fallback);
}

export function messageFailure(error, operation) {
  const detail = typeof error === 'string' ? error : error?.message;
  return `${operation}: ${detail || 'No response from the extension service worker.'}`;
}
