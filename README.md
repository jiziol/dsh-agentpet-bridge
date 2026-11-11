# @agentpet-lite/dsh-bridge

Independent DSH Host/Client adapter for AgentPet Lite. MIT licensed. DSH compatibility,
plugin tests and prebuilt package releases are maintained in this project; AgentPet
consumes a versioned local protocol and does not bundle or build this adapter.

## Status

`0.1.x`, pre-1.0. The companion AgentPet Lite app is distributed separately; this
repository contains only the DSH adapter. The current npm release is `0.1.12`
(https://www.npmjs.com/package/@agentpet-lite/dsh-bridge). The source repository is
being prepared for public release; prebuilt download links will be added with it.

## Install and update

Use DSH's native Plugins → Add plugin manager with the npm package name or a
prebuilt `.tgz`. On macOS desktop use the matching desktop CLI and `desktop`
Profile; `web` is a different environment. Save work and follow the host's restart
instructions. Use a verified prebuilt `.tgz` for offline installation or rollback.

Release artifacts are prebuilt and require no compilation during installation.
The same version can also be delivered as a `.tgz` for offline installation or
rollback. Do not load the old `@acerz/dsh-agentpet-bridge` and this package together.
The package remains independent of `@acerz/dsh-toolkit` and AionUI Team bridges.

### Connect to AgentPet Lite

For a fresh Lite installation, set the bridge Host configuration field
`eventSocket` in DSH's native plugin manager **before starting new tasks**.
Use the complete absolute path to `agentpet.sock` in your Lite data directory.
On macOS, print the normal Lite path with:

```sh
printf '%s/.agentpet-lite/agentpet.sock\n' "$HOME"
```

Copy the printed path into `eventSocket`. Do not enter `~`, `$HOME`, or a relative
path in that field: the plugin does not expand shell expressions. If your Lite
installation uses a custom data directory, use its actual socket path instead.
Save the configuration and follow DSH's restart instructions, then start Lite.
In Lite, select the matching DSH desktop application and click **Test**. Confirm
that the selected instance, protocol and event connection succeed; with one live
DSH Client, also check the advertised navigation/pending capabilities. Zero active
tasks are sufficient for this connection check; it does not create a model task.
Natural task updates and precise navigation need separate use verification.

Existing AgentPet Local users can retain their explicit `eventSocket`, or set its
complete absolute path to `.agentpet-local/agentpet.sock` under their home.
An empty setting preserves the legacy default: `AGENTPET_LOCAL_HOME/agentpet.sock`
when that environment variable is set in the **DSH process**, otherwise
`.agentpet-local/agentpet.sock` under DSH's home directory. Lite users must set the
explicit Lite path; a fresh installation has no Local migration endpoint. The
bridge sends to one configured socket and does not choose between apps by probing
or changing their data directories. Moving from Local to Lite requires reviewing
this setting; updating the plugin does not rewrite it or migrate user data.

## Compatibility

Runtime range is DSH `>=0.2.1-rc.2`; development SDK/generator versions are pinned
separately. An allowed host version is not a claim that every future release has
been tested. Protocol-major compatibility and advertised capabilities decide
AgentPet connectivity; package release numbers do not have to match AgentPet.

Wire v1 lifecycle, public text and exact navigation remain supported. A read-only
status query works with no active sessions and advertises live Client count,
publisher connection and capabilities. Exact agy session bindings are resolved
inside this adapter, never by making AgentPet parse host-private files.
A source checkout includes the pinned public protocol snapshot at
`protocol/dsh-bridge-protocol.md`; the AgentPet Lite project remains the normative owner of the contract. `protocol/`
also contains a pinned synthetic conformance fixture, not application code.
Building this adapter requires no AgentPet checkout.

## Build and candidate packaging

Use Node.js 22+ and Python 3.9+; the CI workflow uses Node.js 22 and Python 3.12.
The last recorded desktop-host connection check used DSH 0.2.1-rc.5 with bridge
0.1.10. Bridge 0.1.11 passed an isolated rc.5 web Host/Client smoke check; 0.1.12 is
a documentation-only patch. Desktop installation and natural use acceptance for the
current release are still pending.

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

EventSocket config is an absolute same-user Unix socket; empty preserves the
legacy AgentPet Local default described above. Only lifecycle metadata and a
bounded current public-text preview leave DSH. No reasoning, tool arguments, credentials or user answers are
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
