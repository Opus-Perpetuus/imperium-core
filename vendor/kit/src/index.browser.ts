// (o==================================================================o)
//   #region PUBLIC API (browser-safe)
// (o-----------------------------------------------------------\/-----o)

/**
 * Browser / Angular UI surface of the kit.
 * Omits Node-only modules (`kirlet/identity` HMAC via node:crypto).
 * Types + pure `kirlet_identity_can` remain available.
 */

export * from './api/envelope.js';
export * from './auth/types.js';
export * from './contrast/pick-readable-text-color.js';
export * from './descriptors/api-data-source.js';
export * from './descriptors/ui-descriptor.js';
export * from './descriptors/feature-shell.js';
// Kirtexto is DOM-free by design (the purifier is injected), so the whole
// pipeline is safe to ship to the browser.
export * from './html/html-profile.js';
export * from './html/normalize-html.js';
export * from './html/sanitize-html.js';
export * from './icons/icon-names.js';
export * from './kirlet/manifest.js';
export * from './kirlet/manifest-validate.js';
export * from './kirlet/semver-lite.js';
export * from './kirlet/widgets.js';
export type { KirletGrant, KirletIdentity } from './kirlet/identity.types.js';
export { kirlet_identity_can } from './kirlet/identity.types.js';
export * from './platform/realms.js';
export * from './tags/types.js';

// (o-----------------------------------------------------------/\-----o)
//   #endregion PUBLIC API (browser-safe)
// (o==================================================================o)
