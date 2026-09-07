/**
 * stdio entry point.
 *
 * On stdio, stdout *is* the protocol channel. The spec is blunt about it: the
 * server must not write anything to stdout that is not a valid MCP message,
 * and messages must not contain embedded newlines. One stray `console.log`
 * from anywhere in the process — including a dependency printing a banner or
 * a deprecation warning on import — puts an unparseable line in front of the
 * first response and the host drops the connection.
 *
 * Depending on a whole dependency tree to never print is not a plan, so the
 * console is redirected to stderr before anything else loads. stderr is the
 * sanctioned logging channel for stdio servers in this revision, now that the
 * protocol's own logging capability is deprecated.
 */

/* eslint-disable no-console -- This module is the one place that is supposed to
   touch the console: it reassigns the console methods so nothing else in the
   process can write to stdout. The rule is enforced everywhere else. */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { DeweyConfig } from "../config.js";
import { buildServer, readVersion } from "./server.js";

/**
 * Point every console method except `error` at stderr. Returns a function that
 * restores them, which the tests use and the server never needs.
 */
export function guardStdout(): () => void {
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    debug: console.debug.bind(console),
  };
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;

  return () => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.debug = original.debug;
  };
}

export async function serve(config: DeweyConfig): Promise<void> {
  guardStdout();

  const version = readVersion(import.meta.url);
  // `serveStdio` rather than constructing a transport and calling connect:
  // the connect path serves only the 2025-era protocol regardless of SDK
  // version. This entry pins the era per connection and can answer both.
  const handle = serveStdio(() => buildServer({ config, version }));

  process.stderr.write(`dewey ${version} serving ${config.root} on stdio\n`);

  const shutdown = () => {
    void handle.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // stdin closing is the portable graceful-shutdown signal for stdio servers.
  process.stdin.on("end", shutdown);

  await new Promise<void>((resolve) => {
    process.on("exit", () => resolve());
  });
}
