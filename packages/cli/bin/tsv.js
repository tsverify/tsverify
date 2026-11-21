#!/usr/bin/env node
// Development launcher: runs the TypeScript sources through tsx. Replaced by a bundle at
// publish time.
import { register } from "tsx/esm/api";

register();
await import("../src/index.ts");
