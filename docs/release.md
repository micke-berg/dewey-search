# Install, remove and release Dewey

Version 0.1.1 is published as `@micke-berg/dewey` on npm. The public source
checkout and versioned GitHub release tarball remain available.

## Requirements

Runtime Node >=22.12. Source development and linting need Node >=22.13 because
the development toolchain has a higher minimum. Check `node --version` in the
actual shell and use an absolute Node executable for MCP if PATH is ambiguous.

Native SQLite, sqlite-vec and ONNX dependencies must support the machine's OS and
architecture. `npm ci` attempts their supported binary installation. If native
build tools are required or corporate policy blocks downloads, stop and use exact
filesystem search until the owner/employer approves a compatible installation.
A denied download is not a reason to disable security controls.

The embedding model is a separate first-index download. Obtain permission before
indexing. `status` and the release smoke test do not download embedding models.
Index paths belong outside notes and must be separate for personal and work data.
A cloud assistant can process retrieved text even though retrieval itself is local.

## npm installation, all platforms

For a global CLI:

```sh
npm install --global @micke-berg/dewey@0.1.1
dewey --help
```

If global installation is restricted, use a dedicated tools folder outside your
notes and install locally:

```sh
npm install --save-exact @micke-berg/dewey@0.1.1
node node_modules/@micke-berg/dewey/dist/cli.js --help
```

Both forms work in PowerShell. Installation does not index notes or download
embedding models. Use the CLI, notes and index paths from this installation when
registering the MCP server below. Remove a global installation with
`npm uninstall --global @micke-berg/dewey`, or run `npm uninstall @micke-berg/dewey`
from the dedicated tools folder for a local installation. Neither removes notes.

## Source installation, all platforms

From the trusted source checkout, using an approved runtime:

```sh
node --version
npm ci
npm run build
node dist/cli.js --help
node dist/cli.js status --notes "../My Vault" --db "../Search Cache/vault.db" --json
```

The commands also work in PowerShell. Paths with spaces must be quoted. Confirm
notes and database paths in the resulting status before indexing. After approval
for model downloads, run `node dist/cli.js index` with the same notes/database flags.
Use the explicit flags for subsequent search commands or set approved environment
variables. Installing a global command or a symlink is unnecessary.

## Tarball installation and removal

The maintainer runs `npm run release:check`. It builds and inspects an allowlisted
pack, installs into a clean temporary consumer with native dependencies, probes
CLI and synthetic search, verifies unchanged notes, and removes the package.
It uses deterministic test embeddings, not a downloaded model. This verifies
package wiring and native storage; it does not measure semantic model quality.

For an owner-provided reviewed tarball, create a separate tool directory, then:

```sh
npm install --omit=dev "../dewey-package.tgz"
node node_modules/@micke-berg/dewey/dist/cli.js --help
npm uninstall @micke-berg/dewey
```

The filename is supplied by the maintainer. Uninstall does not delete notes or
indexes. Stop provider processes first. Remove only the specific derived database
and model cache you have chosen to remove; never delete the notes directory.

## Claude and Codex MCP registration

Replace `NODE_EXECUTABLE`, `DEWEY_CLI`, `VAULT_PATH` and `INDEX_PATH` with absolute
paths. Use the built CLI from the source checkout or installed package. Both
commands work in PowerShell with quoted Windows paths.

```sh
claude mcp add dewey --env "DEWEY_NOTES=VAULT_PATH" "DEWEY_DB=INDEX_PATH" -- "NODE_EXECUTABLE" "DEWEY_CLI" serve
claude mcp get dewey
codex mcp add dewey --env "DEWEY_NOTES=VAULT_PATH" --env "DEWEY_DB=INDEX_PATH" -- "NODE_EXECUTABLE" "DEWEY_CLI" serve
codex mcp get dewey
```

These commands are templates, not completed configuration. Read each registration
back, restart its host if required, then call `index_status` against synthetic
notes first. Do not call it connected until that succeeds. Dewey's protocol and
the host's supported MCP revision must agree; configuration alone does not prove
compatibility. Missing capabilities remain UNKNOWN. No provider login is installed
or verified by the kit's installer.

Remove registration separately in each host:

```sh
claude mcp remove dewey
codex mcp remove dewey
```

Read the host's MCP list back to confirm removal. Then uninstall the package or
remove only the dedicated source build directory if no longer needed.

## Maintainer gate

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
npm run release:check
```

Run from a clean checkout and on Windows, macOS and Linux CI. Review package file
contents and the dependency audit. Version the artifact before publishing.
The source and package are intended to be public. First publication needs an
npm account that owns the package scope, with two-factor authentication enabled.
The package scope belongs to the npm account `micke-berg`.
A successful local pack is not a published release.

After bootstrap publication, configure npm trusted publishing for GitHub owner
`micke-berg`, repository `dewey-search`, workflow `publish.yml`, environment `npm`.
The manual workflow accepts an existing release tag, repeats the checks and
publishes with provenance. It uses GitHub OIDC rather than a stored npm token.
Restrict npm publishing to trusted publishers once that route has been verified.
See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).

Keep version tags immutable. If a release needs a fix, increment the package
version and publish a new release. Never replace an existing tarball.
