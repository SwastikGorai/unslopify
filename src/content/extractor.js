(() => {
  'use strict';

  const MAX_TEXT = 8_000;

  function normalizeText(value) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim();
  }

  function isEligibleText(value) {
    const text = normalizeText(value);
    if (text.length < 20 || text.length > MAX_TEXT) return false;
    const letters = [...text].filter(character => /\p{L}/u.test(character));
    return letters.length >= 3 && letters.filter(character => /[A-Za-z]/u.test(character)).length / letters.length >= 0.7;
  }

  function hashText(value) {
    const text = normalizeText(value);
    let hash = 2_166_136_261;
    for (const character of text) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return `${hash.toString(16).padStart(8, '0')}-${text.length}`;
  }

  function isOwn(node) {
    return Boolean(node?.closest?.('[data-unslopify-ui="true"]'));
  }

  function isNestedCard(card, root, selector) {
    try {
      const parent = card.parentElement?.closest(selector);
      return Boolean(parent && parent !== root && (root ? root.contains(parent) : true));
    } catch {
      return true;
    }
  }

  function extractCard(card, site, root, origin) {
    if (!card || card.nodeType !== 1 || isOwn(card) || isNestedCard(card, root, site.postSelector)) return null;
    let bodies;
    try { bodies = [...card.querySelectorAll(site.bodySelector)]; } catch { return null; }
    if (bodies.length !== 1) return null;
    const body = bodies[0];
    if (isOwn(body)) return null;
    const text = normalizeText(body.innerText || body.textContent);
    if (!text || text.length > MAX_TEXT) return null;
    const controlsText = normalizeText(card.querySelector('[aria-expanded="false"]')?.getAttribute('aria-label') || '');
    const truncated = /see more|show more|read more/iu.test(controlsText) || /\.\.\.$/u.test(text);
    const uncertain = Boolean(card.querySelector('blockquote, [data-testid="quoteTweet"], [data-urn*="reshare"]'));
    const permalink = site.permalinkSelector ? card.querySelector(site.permalinkSelector)?.getAttribute('href') : '';
    let postId;
    if (permalink) {
      try {
        const url = new URL(permalink, origin);
        postId = `${origin}${url.pathname}`;
      } catch { postId = undefined; }
    }
    const textHash = hashText(text);
    const authorLink = card.querySelector('.update-components-actor a[href*="/in/"], .feed-shared-actor a[href*="/in/"], [data-testid="User-Name"] a');
    const authorId = authorLink?.getAttribute('href')?.split('?')[0] || card.querySelector('[data-member-id]')?.getAttribute('data-member-id') || '';
    return {
      postId: postId || `${origin}:${textHash}`,
      authorId: authorId.slice(0, 200),
      text,
      textHash,
      truncated,
      contextUncertain: uncertain,
      extractionVersion: site.extractionVersion
    };
  }

  function routeAction({ changed, stopped, nextSite, currentSite }) {
    if (!nextSite) return changed || !stopped ? 'teardown' : 'wait';
    if (changed || stopped || nextSite.id !== currentSite?.id || nextSite.origin !== currentSite?.origin) return 'reconcile';
    return 'connect';
  }

  function shouldTeardown(message, siteId) {
    return message?.type === 'TEARDOWN' && (!message.siteId || message.siteId === siteId);
  }

  globalThis.__unslopifyExtractor = Object.freeze({ extractCard, isEligibleText, isNestedCard, isOwn, normalizeText, routeAction, shouldTeardown });
})();
