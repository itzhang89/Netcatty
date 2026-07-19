# Plugin security and permission boundary

Status: phase 3 internal preview (`0.1.0-internal`)

This phase is available only with `NETCATTY_PLUGIN_DEV=1`. It is deliberately
usable by later contribution and Provider phases, but it is not a public plugin
release. There is no renderer permission UI yet. If the host does not inject a
decision provider, interactive permission requests fail closed.

## Authority model

Every privileged plugin-to-host method is registered in
`PluginHostRpcRegistry` with one explicit authorization descriptor. Parameters
are validated first; asynchronous resource resolution then produces canonical
resources; quota and permission middleware run immediately before the handler.
An unclassified method is denied. The only current public method is bounded,
redacted logging.

The host supplies immutable plugin ID, version, runtime ID, placement, manifest,
package root, cancellation signal, active-runtime guard, and security principal.
Plugin payload fields can never replace that identity. The default pre-signature
principal is a hash of plugin ID, declared publisher, and immutable package
SHA-256, so changed unsigned code cannot inherit persistent grants. The
placement seam also accepts a `resolveSecurityPrincipal` function so phase 9 can
substitute a verified publisher-key fingerprint without changing the permission
engine.

The grant key includes:

- plugin ID and permission;
- canonical resource;
- required-versus-optional declaration semantics and declared resource bounds;
- the host-resolved security principal.

Changing any declaration boundary or principal invalidates reuse. A renderer
decision cannot grant a resource broader than the manifest declaration.
Permission prompts use the canonical contract directly: absent operation and
session IDs are omitted, long host-generated operation IDs become stable
SHA-256 identifiers, reasons are bounded, and no request can carry more than
128 canonical resources.
Runtime trust/placement resolves before permission prompts. The special
`runtime.advanced` permission is excluded from generic required-permission
preflight and requested exactly once only when the host actually selects the
utility runtime.

## Grant lifetimes

- `once` applies only to the request waiting on that decision and is not stored.
- `session` is held in memory and requires a host-owned session ID; ending the
  session removes it.
- `application` is held in memory until explicit revoke or shutdown.
- `always` is persisted in `plugin_permission_grants`.

All lifetimes use the same resource-coverage function. A filesystem directory
grant covers its descendants with path-boundary comparison; an origin or
companion grant is exact; `*` is valid only when the manifest declaration also
allows it. Concurrent identical prompts coalesce. Prompt timeout, runtime abort,
cancel, denial, absence of a decision provider, and stale activation all fail
closed. Grant/use/deny/revoke events enter the bounded security audit.

`PermissionRequest` is part of the canonical Schema and carries plugin display
identity, version, runtime placement, permission, canonical resources, reason,
operation and optional host session. This is the complete PR-4 UI handoff; the
renderer must return the same request ID and one canonical lifetime decision.

## Host-mediated capabilities

These brokers are the only authority path for ordinary browser plugins. An
advanced utility entrypoint is intentionally different: `runtime.advanced`
means explicit consent to ambient Node, filesystem and network APIs in its
contained process. Fine-grained broker grants do not sandbox that ambient Node
authority. Phase 9 must also require a verified publisher principal before the
advanced path can be publicly enabled.

### Network

The ordinary browser SDK has no direct network primitive. `network.request` supports
HTTP(S) only, exact origin authorization, bounded headers, a 1 MiB request and
response body, explicit timeout, no URL credentials, no ambient cookies, no
transport headers, and manual redirects. Every redirect origin is authorized.
Cross-origin redirects strip sensitive headers; 301/302/303 transitions do not
replay POST bodies as GET requests.

### Filesystem

Read, write, stat and directory listing require an absolute path. Authorization
uses the real path (or real parent for a new file), and the handler requires the
same canonical resource after permission middleware. File opens use
`O_NOFOLLOW` where supported and recheck the opened object. Reads use the actual
handle bytes rather than trusting a pre-read size, with a 1 MiB cap. Writes are
exclusive unless overwrite is explicit, create mode is `0600`, and listing is
limited to 1,000 entries.

### Secrets and credentials

Secret values are encrypted with Electron `safeStorage`; unavailable OS
encryption or Linux's insecure `basic_text` fallback denies the operation.
SQLite stores ciphertext plus an opaque random
`SecretRef`, never plaintext. Secret tables and grants are user-owned security
data and do not cascade when a package version is removed.

Plugins can ask `PluginCredentialBroker` for a `SecretLeaseRef`. A lease is
single-consumption, opaque, maximum 60 seconds, and bound to plugin, active
runtime, operation ID, abort signal and secret ownership. Only a host capability
broker can redeem it. A plugin-owned `SecretRef`, a Netcatty-owned opaque
`CredentialRef`, or a lease ID alone is not authority. Netcatty credential
references use an injected main-process resolver that validates the reference
before prompting and again before lease issue, but resolves plaintext only when
the one-use lease is consumed. This is the stable credential handoff used by
connection/authentication Providers in PR 7.

### Companion executables

Only the manifest variant matching the current OS/architecture can start. Its
real path must remain inside the package, be a regular file, and match the
declared SHA-256 immediately before spawn. The host uses an absolute executable,
empty argument vector, private plugin data directory, minimal environment,
`shell:false`, bounded Content-Length JSON-RPC, at most four processes per
runtime and 64 pending calls per process. Companion-to-host methods receive
method-not-found; privileged work remains in the main host brokers.

Shutdown requests termination, escalates to SIGKILL, and still waits for exit.
An unreaped companion is a containment failure and disables its plugin. Runtime
stop events revoke leases and release all owned companion handles.

## Quotas and failure behavior

The raw-message token bucket runs before schema traversal. Capability
concurrency/rate, logging rate, per-category byte windows, companion count and
pending RPC limits bound retained work. Electron process metrics enforce memory
and sustained-CPU policy for browser/utility runtimes and companion processes.
A process policy violation disables and stops only its owning plugin.

Network, filesystem, secret, credential and companion handlers recheck the
active runtime immediately before commits or returned results. Cancellation,
disable, update, uninstall, quarantine and shutdown therefore cannot resume a
stale privileged operation.

## Initial database policy

The plugin platform has never shipped. The complete current database remains
schema version 1 and includes package/runtime tables plus grants, secrets and
security audit. There is no migration chain. A developer using an older preview
must reset `userData/plugins/plugins.sqlite`; released migrations begin only
after durable user data can exist.

## Downstream contracts

- PR 4 consumes `PermissionRequest`, structured grant lists/revocation, runtime
  events and the existing RPC registry for settings/commands/views.
- PRs 5-6 reuse immutable caller identity, permission middleware, cancellation,
  quotas and runtime-stop cleanup; the direct terminal fast path remains a
  separate MessagePort and must still enforce sensitive-input bypass.
- PR 7 consumes operation-bound secret leases and digest-verified companions.
- PR 8 stores encrypted sync sidecars separately from package cascade storage.
- PR 9 supplies signed publisher principals and trust policy through placement;
  signed identity changes force a fresh grant instead of widening an unsigned
  grant silently.
