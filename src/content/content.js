(() => {
  'use strict';

  if (globalThis.__unslopifyContentLoaded) {
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).then(response => globalThis.__unslopifyApplySettings?.(response?.settings)).catch(() => undefined);
    return;
  }
  globalThis.__unslopifyContentLoaded = true;

  const MAX_QUEUE = 50;
  const PROTOCOL_VERSION = 1;
  const CATEGORY_LABELS = {
    engagement_bait: 'engagement bait',
    generic_filler: 'generic filler',
    empty_hype: 'empty hype'
  };
  const SITES = [
    {
      id: 'linkedin',
      origin: 'https://www.linkedin.com',
      paths: ['/feed'],
      feedRootSelector: '[data-testid="mainFeed"], main',
      postSelector: '[role="listitem"], [data-urn*="activity"], [data-urn*="ugcPost"]',
      bodySelector: '[data-testid="expandable-text-box"], [data-test-id="main-feed-activity-card__commentary"], .feed-shared-update-v2__description, .feed-shared-text',
      permalinkSelector: 'a[href*="/feed/update/"], a[href*="/posts/"]',
      extractionVersion: 'linkedin-1'
    },
    {
      id: 'x',
      origin: 'https://x.com',
      paths: ['/home'],
      feedRootSelector: 'main',
      postSelector: 'article[data-testid="tweet"]',
      bodySelector: '[data-testid="tweetText"]',
      permalinkSelector: 'a[href*="/status/"]',
      extractionVersion: 'x-1'
    }
  ];
  const contentRuntime = globalThis.__unslopifyExtractor;
  const state = {
    settings: null,
    site: null,
    feedRoot: null,
    observer: null,
    intersection: null,
    discoveryTimer: 0,
    routeTimer: 0,
    generation: 0,
    bindings: new WeakMap(),
    completed: new WeakMap(),
    rendered: new Map(),
    pending: new Map(),
    pendingCards: new WeakSet(),
    queued: new WeakSet(),
    revealed: new Set(),
    stopped: false,
    lastUrl: location.href
  };

  const normalizeText = contentRuntime?.normalizeText || (value => String(value ?? '').replace(/\s+/gu, ' ').trim());
  const isEligibleText = contentRuntime?.isEligibleText || (() => false);
  function pathMatches(pathname, paths) {
    return paths.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
  }
  function siteForLocation(settings = state.settings) {
    const builtin = SITES.find(site => location.origin === site.origin && pathMatches(location.pathname, site.paths));
    if (builtin && settings?.enabledSites?.[builtin.id]) return builtin;
    return (settings?.customSites || []).find(site => site.enabled && location.origin === site.origin && pathMatches(location.pathname, site.paths)) || null;
  }
  function isOwn(node) {
    return contentRuntime?.isOwn(node) ?? false;
  }
  function isNestedCard(card, root, selector) {
    return contentRuntime?.isNestedCard(card, root, selector) ?? true;
  }
  function extractCard(card, site) {
    return contentRuntime?.extractCard(card, site, state.feedRoot, location.origin) ?? null;
  }
  function currentBinding(card, extracted) {
    const previous = state.bindings.get(card);
    const changed = !previous || previous.postId !== extracted.postId || previous.textHash !== extracted.textHash || previous.extractionVersion !== extracted.extractionVersion;
    const binding = {
      ...extracted,
      node: card,
      documentGeneration: state.generation,
      cardGeneration: changed ? (previous?.cardGeneration ?? 0) + 1 : previous.cardGeneration,
      settingsRevision: state.settings.revision
    };
    if (changed) removeRender(card);
    state.bindings.set(card, binding);
    return binding;
  }
  function isCurrent(binding) {
    return !state.stopped && state.site && state.site.id === binding.adapterId && state.generation === binding.documentGeneration && state.settings?.revision === binding.settingsRevision && state.bindings.get(binding.node)?.cardGeneration === binding.cardGeneration && state.bindings.get(binding.node)?.textHash === binding.textHash && document.contains(binding.node);
  }
  function qualifies(answers) {
    const thresholds = state.settings.siteThresholds?.[state.site.id] || state.settings.thresholds;
    return Object.entries(answers || {}).filter(([id, answer]) => state.settings.categoryToggles[id] && answer?.choice === 'present' && answer.probabilities?.present >= thresholds.presentProbability && answer.confidence >= thresholds.confidence);
  }
  function labelFor(categories) {
    const label = CATEGORY_LABELS[categories[0]] || 'low-value pattern';
    return `Filtered: ${label}`;
  }
  function makeControl(text, kind, onClick) {
    const control = document.createElement(kind === 'button' ? 'button' : 'span');
    control.dataset.unslopifyUi = 'true';
    control.className = 'unslopify-control';
    control.setAttribute('data-unslopify-ui', 'true');
    control.textContent = text;
    if (kind === 'button') {
      control.type = 'button';
      control.addEventListener('click', onClick);
    } else control.setAttribute('role', 'status');
    return control;
  }
  function render(binding, categories) {
    if (!isCurrent({ ...binding, adapterId: state.site.id })) return;
    removeRender(binding.node);
    if (!categories.length || state.revealed.has(binding.postId)) return;
    const text = labelFor(categories);
    const mode = state.settings.siteModes?.[state.site.id] || state.settings.mode;
    if (mode !== 'collapse' || binding.node.contains(document.activeElement)) {
      const label = makeControl(text, 'span');
      binding.node.parentNode?.insertBefore(label, binding.node);
      state.rendered.set(binding.node, { label });
      return;
    }
    const card = binding.node;
    const original = {
      style: card.getAttribute('style'),
      ariaHidden: card.getAttribute('aria-hidden'),
      inert: card.hasAttribute('inert')
    };
    const placeholder = makeControl(`${text} — Show post`, 'button', () => {
      state.revealed.add(binding.postId);
      restoreCard(card);
      removeRender(card);
    });
    card.parentNode?.insertBefore(placeholder, card);
    card.style.display = 'none';
    card.setAttribute('aria-hidden', 'true');
    card.setAttribute('inert', '');
    state.rendered.set(card, { placeholder, original });
  }
  function restoreCard(card) {
    const record = state.rendered.get(card);
    if (!record?.original) return;
    if (record.original.style == null) card.removeAttribute('style');
    else card.setAttribute('style', record.original.style);
    if (record.original.ariaHidden == null) card.removeAttribute('aria-hidden');
    else card.setAttribute('aria-hidden', record.original.ariaHidden);
    if (record.original.inert) card.setAttribute('inert', '');
    else card.removeAttribute('inert');
  }
  function removeRender(card) {
    const record = state.rendered.get(card);
    if (!record) return;
    restoreCard(card);
    record.label?.remove();
    record.placeholder?.remove();
    state.rendered.delete(card);
  }
  function enqueue(card) {
    if (state.stopped || state.queued.has(card) || state.pendingCards.has(card) || state.pending.size >= MAX_QUEUE || !state.site || !state.settings) return;
    state.queued.add(card);
    const extracted = extractCard(card, state.site);
    if (!extracted) { state.queued.delete(card); removeRender(card); return; }
    const binding = currentBinding(card, extracted);
    state.queued.delete(card);
    if (binding.truncated || binding.contextUncertain || !isEligibleText(binding.text) || state.revealed.has(binding.postId) || state.settings.allowlist.includes(binding.postId) || binding.authorId && state.settings.allowlist.includes(binding.authorId)) return;
    const completed = state.completed.get(card);
    if (completed && completed.postId === binding.postId && completed.textHash === binding.textHash && completed.settingsRevision === binding.settingsRevision) return;
    const requestId = `${binding.postId}:${binding.textHash}:${binding.cardGeneration}:${Date.now().toString(36)}`.slice(0, 256);
    state.pendingCards.add(card);
    state.pending.set(requestId, binding);
    Promise.race([
      chrome.runtime.sendMessage({
        type: 'CLASSIFY_REQUEST',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        adapterId: state.site.id,
        extractionVersion: binding.extractionVersion,
        documentGeneration: binding.documentGeneration,
        postId: binding.postId,
        textHash: binding.textHash,
        postText: binding.text,
        truncated: binding.truncated,
        contextUncertain: binding.contextUncertain,
        settingsRevision: binding.settingsRevision
      }),
      new Promise(resolve => setTimeout(() => resolve({ type: 'CLASSIFY_RESULT', status: 'error', error: { code: 'timeout' } }), 11_000))
    ]).then(result => {
      if (result?.status === 'classified' && isCurrent({ ...binding, adapterId: state.site?.id }) && result.settingsRevision === binding.settingsRevision && result.textHash === binding.textHash) {
        state.completed.set(card, { postId: binding.postId, textHash: binding.textHash, settingsRevision: binding.settingsRevision });
        render(binding, qualifies(result.answers));
      }
    }).catch(() => undefined).finally(() => {
      state.pending.delete(requestId);
      if (![...state.pending.values()].some(pendingBinding => pendingBinding.node === card)) state.pendingCards.delete(card);
      if (document.contains(card)) scheduleDiscovery();
    });
  }
  function discover() {
    if (state.stopped || !state.feedRoot || !state.site || !document.contains(state.feedRoot)) return;
    let cards;
    try { cards = state.feedRoot.querySelectorAll(state.site.postSelector); } catch { return; }
    for (const card of cards) {
      if (state.intersection) state.intersection.observe(card);
      else enqueue(card);
    }
  }
  function scheduleDiscovery() {
    clearTimeout(state.discoveryTimer);
    state.discoveryTimer = setTimeout(discover, 150);
  }
  function connectFeed() {
    if (!state.site || state.stopped) return;
    let root;
    try { root = document.querySelector(state.site.feedRootSelector); } catch { root = null; }
    if (!root) { state.routeTimer = setTimeout(connectFeed, 1_000); return; }
    if (state.feedRoot === root && state.observer) { scheduleDiscovery(); return; }
    state.observer?.disconnect();
    state.intersection?.disconnect();
    state.feedRoot = root;
    state.intersection = 'IntersectionObserver' in window ? new IntersectionObserver(entries => entries.filter(entry => entry.isIntersecting).forEach(entry => enqueue(entry.target)), { rootMargin: '400px', threshold: 0 }) : null;
    state.observer = new MutationObserver(mutations => {
      for (const card of state.rendered.keys()) if (!document.contains(card)) removeRender(card);
      const relevant = mutations.some(mutation => {
        if (isOwn(mutation.target)) return false;
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
        return nodes.length === 0 || nodes.some(node => !isOwn(node));
      });
      if (relevant) scheduleDiscovery();
    });
    state.observer.observe(root, { childList: true, subtree: true, characterData: true });
    discover();
  }
  function updateRoute() {
    const changed = location.href !== state.lastUrl;
    if (changed) {
      state.lastUrl = location.href;
      state.generation += 1;
    }
    const next = siteForLocation();
    const siteChanged = next && (next.id !== state.site?.id || next.origin !== state.site?.origin);
    const action = contentRuntime?.routeAction?.({ changed, stopped: state.stopped, nextSite: next, currentSite: state.site }) ?? (!next ? (changed || !state.stopped ? 'teardown' : 'wait') : changed || state.stopped || siteChanged ? 'reconcile' : 'connect');
    if (action === 'teardown') {
      teardown();
      return;
    }
    if (action === 'wait') return;
    if (action === 'reconcile') {
      for (const card of state.rendered.keys()) removeRender(card);
      state.pending.clear();
      state.pendingCards = new WeakSet();
      state.queued = new WeakSet();
      state.bindings = new WeakMap();
      state.completed = new WeakMap();
      state.revealed.clear();
      state.feedRoot = null;
      state.site = next;
      state.stopped = false;
    }
    connectFeed();
  }
  function teardown() {
    state.stopped = true;
    clearTimeout(state.discoveryTimer);
    clearTimeout(state.routeTimer);
    state.observer?.disconnect();
    state.intersection?.disconnect();
    for (const card of state.rendered.keys()) removeRender(card);
    state.pending.clear();
    state.pendingCards = new WeakSet();
    state.queued = new WeakSet();
    state.bindings = new WeakMap();
    state.revealed.clear();
    state.completed = new WeakMap();
    state.feedRoot = null;
  }
  function applySettings(settings) {
    state.settings = settings || null;
    const nextSite = siteForLocation(settings);
    if (!settings || !nextSite) { state.site = null; teardown(); return; }
    for (const card of state.rendered.keys()) removeRender(card);
    state.completed = new WeakMap();
    state.site = nextSite;
    state.stopped = false;
    state.generation += 1;
    state.observer?.disconnect();
    state.intersection?.disconnect();
    state.feedRoot = null;
    connectFeed();
  }

  globalThis.__unslopifyApplySettings = applySettings;

  function previewRule(rule) {
    if (!rule || location.origin !== rule.origin || !pathMatches(location.pathname, rule.paths || [])) return { ok: false, error: 'off_route' };
    try {
      const root = document.querySelector(rule.feedRootSelector);
      const cards = root ? [...root.querySelectorAll(rule.postSelector)].filter(card => !isNestedCard(card, root, rule.postSelector)) : [];
      const samples = [];
      let ambiguous = 0;
      for (const card of cards.slice(0, 50)) {
        const bodies = [...card.querySelectorAll(rule.bodySelector)];
        if (bodies.length !== 1) { ambiguous += 1; continue; }
        const text = normalizeText(bodies[0].innerText || bodies[0].textContent || '');
        const originalOutline = card.style.outline;
        card.style.outline = '2px solid #7c3aed';
        setTimeout(() => {
          if (!document.contains(card)) return;
          card.style.outline = originalOutline;
        }, 5_000);
        if (text) samples.push(text.slice(0, 240));
      }
      return { ok: true, count: cards.length, ambiguous, samples: samples.slice(0, 10) };
    } catch { return { ok: false, error: 'invalid_selector' }; }
  }

  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).then(response => applySettings(response?.settings)).catch(() => { state.settings = null; state.site = null; teardown(); });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'PREVIEW_RULE') { sendResponse(previewRule(message.rule)); return true; }
    if (message?.type === 'SETTINGS_CHANGED') applySettings(message.settings);
    if (contentRuntime?.shouldTeardown?.(message, state.site?.id) ?? (message?.type === 'TEARDOWN' && (!message.siteId || message.siteId === state.site?.id))) { state.settings = null; state.site = null; teardown(); }
  });
  addEventListener('popstate', updateRoute);
  addEventListener('visibilitychange', updateRoute);
  setInterval(updateRoute, 2_000);
})();
