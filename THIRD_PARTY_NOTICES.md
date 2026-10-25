# Third-party notices

The browser entry `lib/client.js` bundles Zod **4.6.7**, licensed under MIT,
Copyright (c) 2025 Colin McDonnell. The full upstream license is included in
`third-party-licenses/Zod-4.6.7-LICENSE.txt` and must accompany redistribution of this bundle.
The dependency version and integrity are locked in `package-lock.json`.

DSH Host dependencies are provided by the compatible DSH installation as peer
dependencies. The build uses the pinned official Typert generator and TypeScript;
its temporary SDK declaration mirror is for static analysis and is not shipped.
Other build dependencies are not bundled as runtime implementations.

The bridge's own source code is MIT, Copyright (c) 2026 acerz. The original
AgentPet application and pet animation assets have separate notices in the
AgentPet Lite repository; their authors are not attributed as authors of this
independently maintained DSH bridge.
