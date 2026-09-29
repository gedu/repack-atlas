/**
 * Copyright (c) Callstack, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Vendored from callstack/repack, branch feat/federation-manifest,
 * commit c5df67f0, path packages/repack/src/plugins/federationManifest/. See VENDORED.md.
 */
export {
  applyFederationManifest,
  type FederationManifestParams,
  normalizeFederationManifestOption,
} from './applyFederationManifest.js';
export { buildFederationManifest } from './buildFederationManifest.js';
export { detectNativeModules } from './detectNativeModules.js';
export {
  DEFAULT_MANIFEST_FILENAME,
  type FederationManifest,
  type FederationManifestExposeEntry,
  type FederationManifestNativeBlock,
  type FederationManifestObjectOptions,
  type FederationManifestOption,
  type FederationManifestRemoteEntry,
  type FederationManifestSharedEntry,
  type FederationNativeModule,
  type NativeModuleConfidence,
} from './types.js';
