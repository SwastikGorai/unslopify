# Unslopify

Unslopify is a Manifest V3 Chrome extension that labels configurable feed patterns such as AI slop and engagement bait. AI slop means templated low-value content quality; it does not infer AI authorship. Pending, uncertain, unsupported, and failed classifications stay visible.

## Local setup

```text
npm install
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `dist/`. Open **Options**, choose a recipient route, paste that route's own API key, review the disclosure, and explicitly enable a site. Keys are kept in restricted `chrome.storage.session`; browser restart requires entering the key again. Gateway keys are not sent to TypeSafe direct, and direct keys are not sent to Gateway.

The default route uses AI SDK 7's `experimental_evaluate()` with `gateway.evaluationModel('typesafe-ai/jev')`. The build bundles the SDK into the extension; the Gateway key still stays in restricted session storage. The direct option uses TypeSafe's documented endpoint and `jev-latest`; no silent route or model fallback is used.

## Checks

- `npm run typecheck` checks JavaScript syntax and manifest JSON without downloading tools.
- `npm test` runs offline contract, policy, fixture-boundary, and response-validation checks; it never needs a key or transmits post text.
- `npm run build` copies the MV3 source and bundles the AI SDK worker into `dist/`.
- `npm run test:e2e` serves the sanitized LinkedIn fixture, loads a temporary test overlay of the built extension in Chromium, and asserts the production extractor's bounded-card output; it clearly skips when `CHROME_BIN` or `CHROMIUM_BIN` is unavailable.
- `npm run eval:jev` sends one synthetic example only when the explicitly selected route key is provided as `AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY` (`JEV_TRANSPORT=direct` selects the latter). `JEV_TRANSPORT=deterministic node eval/run.mjs` runs a clearly marked test-only typed response with no network and no production/dist behavior. Live output is redacted and never includes post text or the key.
- `npm run eval:local` reports raw-count metrics from a redacted prediction file (`EVAL_PREDICTIONS=...`); the checked-in synthetic fixture is not a quality claim and currently has no predictions.

## Permissions and data

The extension has storage and scripting permissions, a fixed Gateway host permission, and optional exact site/API origins. It registers a content script only for an enabled, granted route. The worker recomputes the text hash, owns credentials and network access, validates the typed response, and applies a bounded daily/minute budget. Content scripts receive no key, raw provider response, or unrelated page data.

LinkedIn `/feed/` and X `/home/` are the bundled adapters. Text-only, English-dominant posts with clear boundaries are eligible; short, non-English, truncated, quote-dependent, image-only, private, comments, messages, profile/search pages, and ambiguous cards remain visible. Custom rules accept exact HTTPS origins, path prefixes, and CSS selectors; they cannot contain JavaScript. Preview samples are local and make no Jev call.

No live Jev credential, authorized LinkedIn session, or Chromium binary was available during this implementation. The offline checks and build pass; the live inference and real-site smoke gates remain to be run with user-owned access.
