import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package root, resolved from this module. `src/paths.ts` (tests) and
 * `dist/paths.js` (built CLI) both sit one level below the root.
 */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The checked-in routing table. */
export const DEFAULT_MODELS_PATH = join(PACKAGE_ROOT, 'models.yaml');
