# Releasing

The release workflow intentionally stops before npm publication. npm publishing
requires the maintainer's 2FA and is always a manual step.

## Checklist

1. Update `version` in `package.json` and `package-lock.json`.
2. Run:
   ```sh
   npm ci --ignore-scripts --legacy-peer-deps
   npm run build
   npm test
   npm run test:packaging
   npm run pack:tgz
   ```
3. Commit the release, for example:
   ```sh
   git add package.json package-lock.json README.md
   git commit -m "release: X.Y.Z"
   ```
4. Create and push the tag:
   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```
5. The `Release` GitHub Actions workflow verifies the tag, builds the offline
   package and creates the GitHub Release with `SHA256SUMS`.
6. **Manual npm publish** (2FA required):
   ```sh
   npm login
   npm publish --access public
   npm view @agentpet-lite/dsh-bridge version
   ```
   Do not add an `NPM_TOKEN` or automatic npm publish without an explicit
   maintainer decision and review.
7. Verify the published tarball and install it from the registry before switching
   the desktop/test profiles.
8. Natural desktop task/navigation acceptance remains separate from tests,
   packaging and release creation.
