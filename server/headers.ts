/**
 * The response headers of every response (SEC-1..SEC-3), in a module without
 * imports.
 */

/**
 * SEC-1: the spec's Content-Security-Policy, narrowed only in `img-src`: the
 * app shows no external or blob: images, so images come from the app itself.
 * Never widen it (WF-4).
 */
export const contentSecurityPolicy = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'",
  "font-src 'self'", "connect-src 'self'", "media-src 'self'", "worker-src 'self'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

/** SEC-1 and SEC-2: on every response. */
export const securityHeaders = {
  'content-security-policy': contentSecurityPolicy,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
};

/** SEC-3: API and HTML responses are never cached; only hashed `/assets/` files are. */
export const noStoreHeaders = {
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  pragma: 'no-cache',
  expires: '0',
};
