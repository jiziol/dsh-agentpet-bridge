import { execFileSync } from 'node:child_process'
import { writeFile, readFile, readdir, cp, mkdir, rm, symlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = fileURLToPath(new URL('../', import.meta.url))
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json')], { stdio: 'inherit' })
// The official generator expects a packages/ workspace. Stage compiler inputs
// only; the canonical implementation remains src/ and lib/ in this component.
const workspace = path.join(root, '.build/typert')
await rm(workspace, { recursive: true, force: true })
const project = path.join(workspace, 'packages/bridge')
await mkdir(project, { recursive: true })
for (const entry of ['src', 'lib', 'tsconfig.json', 'package.json']) await cp(path.join(root, entry), path.join(project, entry), { recursive: true })
await symlink(path.join(root, 'node_modules'), path.join(workspace, 'node_modules'), 'dir')
// rc.2 identifies decorator symbols only in a registered compiler package, not
// in an npm external. Mirror the official declarations for analysis only.
// Official 0.2.1 declarations import with `.ts` specifiers; mirror them as `.js`
// so the analysis compiles without allowImportingTsExtensions.
const protocol = path.join(workspace, 'packages/protocol')
await mkdir(protocol, { recursive: true })
await mkdir(path.join(protocol, 'src'), { recursive: true })
const protocolTypes = path.join(root, 'node_modules/@deepseek-ai/dsh-typert-protocol/lib/types')
for (const file of await readdir(protocolTypes)) {
  if (!file.endsWith('.d.ts')) continue
  const source = await readFile(path.join(protocolTypes, file), 'utf8')
  await writeFile(path.join(protocol, 'src', file.replace('.d.ts', '.ts')), source.replace(/\.ts(['"])/g, '.js$1'))
}
await cp(path.join(root, 'node_modules/@deepseek-ai/dsh-typert-protocol/package.json'), path.join(protocol, 'package.json'))
const compilerOptions = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, lib: ['ES2022', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'] }
await writeFile(path.join(protocol, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['src/**/*.ts'] }))
const options = JSON.parse(await readFile(path.join(project, 'tsconfig.json'), 'utf8'))
options.compilerOptions.paths = { '@deepseek-ai/dsh-typert-protocol': ['../protocol/src/index.ts'] }
options.compilerOptions.lib = ['ES2022', 'DOM', 'DOM.Iterable', 'ESNext.Disposable']
await writeFile(path.join(project, 'tsconfig.json'), JSON.stringify(options))
await writeFile(path.join(workspace, 'tsconfig.host.json'), JSON.stringify({ files: [], references: [{ path: './packages/bridge' }, { path: './packages/protocol' }],
  compilerOptions: { ...compilerOptions, paths: { '@deepseek-ai/dsh-typert-protocol': ['./packages/protocol/src/index.ts'] } } }))
const generator = new WorkspaceTypertGenerator(workspace)
const artifacts = generator.generate(['@agentpet-lite/dsh-bridge'], ['host'])
if (artifacts.length !== 1 || !artifacts[0].remote) throw new Error('bridge Remote generation missing')
const artifact = artifacts[0]
await writeFile(path.join(root, 'lib/typert.host.js'), artifact.js)
await writeFile(path.join(root, 'lib/typert.host.d.ts'), artifact.dts)
await writeFile(path.join(root, 'lib/typert.remote-client.js'), artifact.remote.js)
await writeFile(path.join(root, 'lib/typert.remote-client.d.ts'), artifact.remote.dts)
const body = (await readFile(path.join(root, 'src/client-body.js'), 'utf8')).replace("return { apply, inject:", "export default { apply, inject:")
const result = buildSync({ stdin: { contents: "import TYPERT_REMOTE from './lib/typert.remote-client.js'\n" + body, resolveDir: root },
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', write: false, minify: true, metafile: true })
// Validate the dependencies actually shipped in the Client, including small
// helper implementations that also happen to be declared as Host peers.
const bundledLicenses = new Map([
  ['zod', ['4.6.7', 'Zod-4.6.7-LICENSE.txt']],
  ['@deepseek-ai/dsh-typert-protocol', ['0.2.1-rc.2', 'DSH-Typert-Protocol-0.2.1-rc.2-LICENSE.txt']],
])
const bundledPackages = new Set()
for (const output of Object.values(result.metafile.outputs)) {
  for (const [input, contribution] of Object.entries(output.inputs)) {
    if (contribution.bytesInOutput === 0) continue
    const dependency = input.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1]
    if (dependency) bundledPackages.add(dependency)
  }
}
for (const dependency of bundledPackages) {
  const notice = bundledLicenses.get(dependency)
  if (!notice) throw new Error(`Bundled dependency needs a license review: ${dependency}`)
  const [version, filename] = notice
  const directory = path.join(root, 'node_modules', dependency)
  const installed = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  const upstream = await readFile(path.join(directory, 'LICENSE'))
  const distributed = await readFile(path.join(root, 'third-party-licenses', filename))
  if (installed.version !== version || !upstream.equals(distributed)) {
    throw new Error(`Bundled license/version mismatch: ${dependency}`)
  }
}
const bundle = result.outputFiles[0].text
await writeFile(path.join(root, 'lib/client.js'), `window.__ModuleLoader__.load({ id: '@agentpet-lite/dsh-bridge', factory: (require) => {
const module = { exports: {} }; const exports = module.exports;
${bundle}
return module.exports.default;
} })\n`)
