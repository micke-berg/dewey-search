/**
 * Dewey — hybrid search and staleness reporting over a folder of markdown.
 *
 * Importing this package gives you the engine. The MCP server and the CLI are
 * built on top of it and have no privileged access to anything here.
 */

export * from "./core/index.js";
export {
  resolveConfig,
  configSchema,
  defaultDbPath,
  ConfigError,
  KNOWN_MODELS,
  DEFAULT_MODEL,
  DEFAULT_RERANK_MODEL,
  CACHE_HOME,
} from "./config.js";
export type { DeweyConfig, KnownModel, ResolveConfigInput } from "./config.js";
