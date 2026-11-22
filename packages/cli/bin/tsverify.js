#!/usr/bin/env node
// Development launcher: runs the TypeScript sources through tsx. The published package's bin is
// the esbuild bundle dist/tsverify.js instead (publishConfig.bin, scripts/build.ts).
import { register } from "tsx/esm/api";

register();
await import("../src/index.ts");
