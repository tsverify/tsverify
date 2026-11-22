export type { PersistenceAdapter, PersistenceFacts } from "./adapters/types";
export type { ExtractOptions, ExtractResult, ExtractStats } from "./extract";
export { extractAll } from "./extract";
export type { LoadedTypeScript, TypeScriptLoadError } from "./load-typescript";
export { loadTypeScript, MIN_TYPESCRIPT } from "./load-typescript";
export type { LiteralSet, Narrowed, NarrowHandle, NarrowRequest, TypeFacts } from "./type-facts";
export type { TypeScript } from "./typescript";
