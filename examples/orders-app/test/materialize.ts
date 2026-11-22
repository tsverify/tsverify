/**
 * Builds a runnable copy of the orders app, optionally with a seeded-bug variant applied: the
 * shared example helpers (`examples/shared/materialize.ts`) bound to this app's directory.
 * Used by the app's own tests and the `tsverify` end-to-end suites.
 */
import { exampleApp } from "../../shared/materialize";

export {
  type ExpectedFinding,
  MANIFEST,
  type MaterializedApp,
  matchesExpected,
  parseManifest,
  type VariantManifest,
} from "../../shared/materialize";

const app = exampleApp(new URL("..", import.meta.url));

export const { APP_ROOT, VARIANTS_ROOT, listVariants, readManifest, overlayFiles, materialize } =
  app;
