// (o==================================================================o)
//   #region PUBLIC API
// (o-----------------------------------------------------------\/-----o)

/**
 * Full kit surface for Node (API, kirlets, tests).
 * Browser / Angular UI must import via path alias to `index.browser.ts`
 * so `node:crypto` identity is never pulled into the client graph.
 */

export * from './api/envelope.js';
export * from './auth/types.js';
export * from './contrast/pick-readable-text-color.js';
export * from './descriptors/api-data-source.js';
export * from './descriptors/ui-descriptor.js';
export * from './descriptors/feature-shell.js';
export * from './html/html-profile.js';
export * from './html/normalize-html.js';
export * from './html/sanitize-html.js';
export * from './icons/icon-names.js';
export * from './kirlet/manifest.js';
export * from './kirlet/manifest-validate.js';
export * from './kirlet/semver-lite.js';
export * from './kirlet/identity.js';
export * from './kirlet/schema.js';
export * from './kirlet/data-client.js';
export * from './kirlet/memory-data-client.js';
export * from './kirlet/http-data-client.js';
export * from './kirlet/router.js';
export * from './kirlet/http.js';
export * from './kirlet/errors.js';
export * from './kirlet/runtime-auth.js';
export * from './kirlet/runtime-config.js';
export * from './kirlet/file-store.js';
export * from './kirlet/nox-services.js';
export * from './kirlet/memory-nox-services.js';
export * from './kirlet/http-nox-services.js';
export * from './kirlet/define-module.js';
export * from './kirlet/define-crud.js';
export * from './kirlet/define-kirlet.js';
export * from './kirlet/serve.js';
export {
  define_kirlet as define_subject,
} from './kirlet/define-kirlet.js';
export {
  serve_kirlet as serve_subject,
} from './kirlet/serve.js';
export * from './kirlet/conformance.js';
export * from './kirlet/widgets.js';
export * from './platform/realms.js';
export * from './tags/types.js';

// (o-----------------------------------------------------------/\-----o)
//   #endregion PUBLIC API
// (o==================================================================o)
