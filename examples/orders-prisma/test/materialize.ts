/**
 * Builds a runnable copy of the Prisma orders app, optionally with a seeded-bug variant applied:
 * the shared example helpers (`examples/shared/materialize.ts`) bound to this app's directory.
 */
import { exampleApp } from "../../shared/materialize";

export {
  type ExpectedFinding,
  type MaterializedApp,
  matchesExpected,
  type VariantManifest,
} from "../../shared/materialize";

const app = exampleApp(new URL("..", import.meta.url));

export const { APP_ROOT, VARIANTS_ROOT, listVariants, readManifest, overlayFiles, materialize } =
  app;
