# @agentpet-lite/dsh-bridge

Independent DSH Host/Client adapter for AgentPet Lite. MIT licensed. DSH compatibility,
plugin tests and prebuilt package releases are maintained in this project; AgentPet
consumes a versioned local protocol and does not bundle or build this adapter.

## Status

`0.1.x`, pre-1.0. The companion AgentPet Lite app is distributed separately; this
repository contains only the DSH adapter. See Releases for prebuilt packages.

## Install and update

Use DSH's native Plugins → Add plugin manager with the npm package name or a
prebuilt `.tgz`. On macOS desktop use the matching desktop CLI and `desktop`
Profile; `web` is a different environment. Save work and follow the host's restart
instructions. If the npm release is not yet available, use the `.tgz` from Releases.

Release artifacts are prebuilt and require no compilation during installation.
The same version can also be delivered as a `.tgz` for offline installation or
rollback. Do not load the old `@acerz/dsh-agentpet-bridge` and this package together.
The package remains independent of `@acerz/dsh-toolkit` and AionUI Team bridges.

## Compatibility

Runtime range is DSH `>=0.2.1-rc.2`; development SDK/generator versions are pinned
separately. An allowed host version is not a claim that every future release has
been tested. Protocol-major compatibility and advertised capabilities decide
AgentPet connectivity; package release numbers do not have to match AgentPet.

Wire v1 lifecycle, public text and exact navigation remain supported. A read-only
status query works with no active sessions and advertises live Client count,
publisher connection and capabilities. Exact agy session bindings are resolved
inside this adapter, never by making AgentPet parse host-private files.
The public protocol snapshot is [`protocol/dsh-bridge-protocol.md`](protocol/dsh-bridge-protocol.md);
the AgentPet Lite project remains the normative owner of the contract. `protocol/`
also contains a pinned synthetic conformance fixture, not application code.
Building this adapter requires no AgentPet checkout.

## Build and candidate packaging

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run build
npm test
npm run test:packaging
npm pack
npm run pack:tgz
```

`npm pack` builds before packaging; install-time prepare/postinstall scripts are
not used. npm archives include prebuilt lib files and licenses. The Python tool
creates a reproducible four-file offline bundle and never accesses DSH homes or
installs anything.
`lib/observer.js`, `lib/transport.js` and their declarations are maintained sources;
do not delete all of `lib/` before building. Keep their identities and framing
independent of generated Typert Host/Client descriptors.

## Boundaries

EventSocket config is an absolute same-user Unix socket; empty uses the local
AgentPet data socket. Only lifecycle metadata and a bounded current public-text
preview leave DSH. No reasoning, tool arguments, credentials or user answers are
published. Baselines/reconnects do not replay old text or invent completions.
Queues, frames and session counts are bounded. Navigation validates exact
Profile/Host/Client generation/request/session identity; timeout or ambiguity
cannot mark a task read. Local sockets use private 0700 directories and 0600
socket files. Same-UID malicious processes are outside this isolation boundary.
Status and binding operations never navigate, acknowledge, answer, approve or
execute arbitrary commands. DSH operations remain under the native host's control.

## Upgrade regression checklist

1. Build SDK/descriptor generation, Node protocol/Client tests and isolated package checks.
2. In an explicitly authorized isolated DSH environment, verify Host and Client loading and errors.
3. With zero sessions, status must report protocol/capabilities and the actual event connection without creating a task.
4. Normal work/completion, human choice/reply/permission, cancellation, failure and connection loss keep distinct states.
5. Public-text preview contains committed current text only; reconnect, cancellation and replacement do not replay stale text.
6. Precise navigation plus foreground verification and read receipt remain exact; wrong generation, missing/ambiguous Clients and timeout fail safely.
7. Exact agy binding lookup returns matched/notFound/ambiguous/unavailable and never modifies host records.
8. Confirm a compatible older consumer accepts a newer adapter; unknown protocol majors and unavailable capabilities are reported accurately.
9. Verify disable/uninstall disposes sockets/timers/subscriptions and preserves host sessions/user data. Multi-window, real sleep and long-running behavior require separate evidence.

Source tests, packaging, host installation and natural desktop acceptance are
distinct results; passing tests is not a claim of host acceptance.

## Contributing

Issues and pull requests are welcome once this repository is public. Keep protocol
changes within the compatibility rules and include tests with each change.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for attribution.
