# Third-party notices

The browser entry `lib/client.js` bundles Zod **4.6.7**, licensed under MIT,
Copyright (c) 2025 Colin McDonnell. The full upstream license is included in
`third-party-licenses/Zod-4.6.7-LICENSE.txt` and must accompany redistribution of this bundle.
The dependency version and integrity are locked in `package-lock.json`.

The same entry also bundles the `remote-info` implementation from
`@deepseek-ai/dsh-typert-protocol` **0.2.1-rc.2**, licensed under MIT,
Copyright (c) 2026 DeepSeek. The complete upstream license is included in
`third-party-licenses/DSH-Typert-Protocol-0.2.1-rc.2-LICENSE.txt` and must accompany
redistribution of this bundle. The build checks the actual bundled dependencies,
their versions and their distributed license copies against the installed sources.

DSH Host dependencies are provided by the compatible DSH installation as peer
dependencies. The build uses the pinned official Typert generator and TypeScript;
its temporary SDK declaration mirror is for static analysis and is not shipped.
The bundled Typert helper and Zod retain the notices above; other build dependencies
are not bundled as runtime implementations.

The bridge's own source code is MIT, Copyright (c) 2026 acerz. The original
AgentPet application and pet animation assets have separate notices in the
AgentPet Lite repository; their authors are not attributed as authors of this
independently maintained DSH bridge.

The protocol snapshot in `protocol/dsh-bridge-protocol.md` is provided by the
AgentPet Lite project under the MIT license; the AgentPet Lite application and
its own notices are maintained separately.
