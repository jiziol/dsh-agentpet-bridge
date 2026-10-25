#!/usr/bin/env python3
"""Package the prebuilt DSH bridge reproducibly, without npm or installation.

Requires Python 3.9+. The checked-in lib/ is part of the bridge source contract;
run its documented build and tests before packaging a changed implementation.
Only this tool's intact four-file output may be replaced by a subsequent run.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile
import tempfile


PACKAGE = "@agentpet-lite/dsh-bridge"
LEGACY_PACKAGE = "@acerz/dsh-agentpet-bridge"
GENERATOR = "dsh-agentpet-bridge/package-bridge.py"
ROOT_FILES = {
    "package.json", "cordis.patch.yml", "README.md", "LICENSE",
    "THIRD_PARTY_NOTICES.md",
}
HEX = re.compile(r"[0-9a-f]{64}\Z")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\Z")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def archive_name(package, version):
    prefix = "acerz-dsh-agentpet-bridge-" if package == LEGACY_PACKAGE else "agentpet-lite-dsh-bridge-"
    return prefix + version + ".tgz"


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def no_duplicate_keys(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON key: " + key)
        value[key] = item
    return value


def read_json(data):
    value = json.loads(data, object_pairs_hook=no_duplicate_keys)
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


def reject_symlinks(path):
    """Check the supplied path before resolving it, including its parents."""
    path = Path(os.path.abspath(path))
    for candidate in (path, *path.parents):
        if candidate.is_symlink():
            raise ValueError("Refusing symbolic link: " + str(candidate))
    return path


def regular_bytes(path):
    mode = path.lstat()
    if not stat.S_ISREG(mode.st_mode) or mode.st_nlink != 1:
        raise ValueError("Refusing non-regular or hard-linked file: " + str(path))
    return path.read_bytes()


def collect_tree(root, relative, allowed):
    directory = root / relative
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError("Missing or linked directory: " + relative)
    result = {}
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise ValueError("Refusing source symbolic link: " + str(path))
        if path.is_dir():
            continue
        name = path.relative_to(root).as_posix()
        if not allowed(name):
            raise ValueError("Unexpected distributable file: " + name)
        result[name] = regular_bytes(path)
    if not result:
        raise ValueError("Empty distributable directory: " + relative)
    return result


def local_target(value):
    if not isinstance(value, str) or "\\" in value:
        raise ValueError("Invalid package entry point")
    target = PurePosixPath(value)
    if target.is_absolute() or ".." in target.parts:
        raise ValueError("Escaping package entry point: " + value)
    name = target.as_posix()
    if not (name.startswith("lib/") or name in {"package.json", "cordis.patch.yml"}):
        raise ValueError("Entry point outside runtime allowlist: " + value)
    return name


def collect(source):
    source = reject_symlinks(source)
    if not source.is_dir():
        raise ValueError("Bridge source is not a directory")
    files = {name: regular_bytes(source / name) for name in sorted(ROOT_FILES)}
    files.update(collect_tree(source, "lib", lambda name: name.endswith((".js", ".d.ts"))))
    files.update(collect_tree(source, "third-party-licenses", lambda name: name.endswith((".txt", ".md"))))
    package = read_json(files["package.json"])
    if package.get("name") != PACKAGE or not VERSION.fullmatch(package.get("version", "")):
        raise ValueError("Unexpected bridge package name or version")
    peers = package.get("peerDependencies", {})
    dsh_range = peers.get("@deepseek-ai/dsh-agent", "")
    dsh_version = dsh_range.removeprefix(">=")
    if not VERSION.fullmatch(dsh_version):
        raise ValueError("An exact DSH version or >= minimum DSH version is required")
    if any(value != dsh_range for name, value in peers.items() if name.startswith("@deepseek-ai/dsh-")):
        raise ValueError("DSH peer requirements must use the same runtime range")
    if package.get("engines", {}).get("dsh", dsh_range) != dsh_range:
        raise ValueError("DSH engine and peer requirements must agree")
    entries = [package.get("main"), package.get("types")]

    def exported(value):
        if isinstance(value, str):
            entries.append(value)
        elif isinstance(value, dict):
            for nested in value.values():
                exported(nested)
        elif isinstance(value, list):
            for nested in value:
                exported(nested)
        elif value is not None:
            raise ValueError("Invalid package exports")

    exported(package.get("exports", {}))
    if package.get("module"):
        entries.append(package["module"])
    entries.append(package.get("dsh", {}).get("bundle", {}).get("patch"))
    for entry in entries:
        if local_target(entry) not in files:
            raise ValueError("Package entry point missing: " + str(entry))
    # The current bridge has no bundled npm dependencies, native add-ons or bin.
    if package.get("dependencies") or package.get("bundledDependencies") or package.get("bin"):
        raise ValueError("Runtime dependency layout changed; review the packager allowlist")
    forbidden = (str(source).encode(), b"/Users/", b"/private/var/", b"file:///")
    for name, data in files.items():
        if any(value in data for value in forbidden):
            raise ValueError("Machine-specific absolute path in distributable: " + name)
        if name.startswith("lib/"):
            # Check relative static imports/exports/requires in JS and declarations.
            text = data.decode("utf-8")
            references = re.findall(r'''(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.[^"']+)["']''', text)
            for reference in references:
                components = list(PurePosixPath(name).parent.parts)
                for component in PurePosixPath(reference).parts:
                    if component == "..":
                        if not components:
                            raise ValueError("Escaping relative import in " + name)
                        components.pop()
                    elif component != ".":
                        components.append(component)
                resolved = "/".join(components)
                candidates = {resolved, resolved + ".js", resolved + ".d.ts", resolved + "/index.js"}
                if resolved.endswith(".js"):
                    candidates.add(resolved[:-3] + ".d.ts")
                if not candidates.intersection(files):
                    raise ValueError("Missing relative import in " + name + ": " + reference)
    return source, package, dsh_version, files


def archive_bytes(files):
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0, compresslevel=9) as zipped:
        with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name, data in sorted(files.items()):
                info = tarfile.TarInfo("package/" + name)
                info.size = len(data)
                info.mode = 0o644
                info.mtime = 0
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


def instructions(archive, version, dsh_version):
    return ("""# AgentPet Lite — DSH bridge

此目录是独立 DSH bridge 的离线安装包，版本 %s，运行范围 DSH %s。
由独立 dsh-agentpet-bridge 项目维护。取得这些文件不会自动安装或修改 DSH。

## 安装或升级

1. 保留此目录全部四个文件。在此目录运行 `shasum -a 256 -c SHA256SUMS`。
2. 确认 DSH 版本匹配。先在 DSH 桌面菜单“管理 dsh 命令”安装命令，
   确认该命令属于同一套 DSH；确认需要安装的 DSH_HOME 与 desktop Profile。
3. 完全退出 DSH。若旧 toolkit 已含同名 bridge，先通过 DSH 插件管理器
   升级为不含 bridge 的 toolkit，保留其他组件和配置。若是旧名独立包
   @acerz/dsh-agentpet-bridge，先用原生管理器 Remove，再安装本包；不要同时加载
   新旧两名。显式引用旧包名的用户 patch 需先保留 config 并处理引用。保留回退副本。
4. 使用 DSH 自己的插件管理器添加本地 tarball；已验证的 CLI 形式如下。
   将两个绝对路径占位符替换为你的实际路径，不要直接复制占位符执行。

   ```sh
   DSH_HOME='<your-absolute-dsh-home>' dsh plugin --profile desktop add '<your-extracted-directory>/%s' --ignore-scripts --save-exact --yes
   ```

5. 启动 AgentPet Lite 与 DSH，确认 bridge 的 Host / Client 均加载，再实际检查
   任务状态、公开回复气泡及点击回到对应会话。文件校验通过不等于运行验收通过。
   本包只提供 bridge，不包含课程护栏、侧栏或其他 toolkit 功能。

## 卸载与回退

完全退出 DSH 后，通过 DSH 自己的插件管理器移除本包：

```sh
DSH_HOME='<your-absolute-dsh-home>' dsh plugin --profile desktop remove @agentpet-lite/dsh-bridge --yes
```

然后重新打开 DSH，
以释放已加载的 Host / Client。删除下载或复制的目录不会卸载已安装的组件。
需要回退时，恢复先前保留的插件包及相应配置；不要同时启用两份同名组件。
AgentPet Lite 的用户数据、宠物素材、会话历史不属于插件卸载范围。

包内 `package/README.md` 说明运行契约和兼容边界；`package/LICENSE`、
`package/THIRD_PARTY_NOTICES.md` 与 `package/third-party-licenses/` 提供许可。
manifest.json 记录版本、归档及每个包内文件的 SHA256；SHA256SUMS 校验此目录
的安装包、说明和 manifest。运行时依赖由匹配的 DSH 提供，浏览器 bundle 中的
第三方代码按随包通知许可分发。允许运行的版本范围与实际验收版本分别记录；
后续版本可运行，但不代表已经逐版本验收。多窗口情形仍需单独验证。
""" % (version, dsh_version, archive)).encode("utf-8")


def validate_output(output, allow_legacy=False):
    """Read and verify a complete output directory; never adopt arbitrary data."""
    output = reject_symlinks(output)
    if not output.is_dir():
        raise ValueError("Output is not a directory")
    manifest = read_json(regular_bytes(output / "manifest.json"))
    if (manifest.get("schemaVersion") != 1 or manifest.get("generator") != GENERATOR
            or manifest.get("package") not in ({PACKAGE, LEGACY_PACKAGE} if allow_legacy else {PACKAGE})
            or not VERSION.fullmatch(manifest.get("version", ""))):
        raise ValueError("Output is not owned by this packager")
    if "dshVersionRange" in manifest and manifest["dshVersionRange"] != ">=" + manifest.get("dshVersion", ""):
        raise ValueError("Invalid managed DSH runtime range")
    archive = archive_name(manifest["package"], manifest["version"])
    expected = {archive, "README.md", "manifest.json", "SHA256SUMS"}
    if manifest.get("archive") != archive or {p.name for p in output.iterdir()} != expected:
        raise ValueError("Unexpected files in output directory")
    hashes = manifest.get("filesSHA256", {})
    if set(hashes) != {archive, "README.md"}:
        raise ValueError("Invalid managed output file manifest")
    contents = {name: regular_bytes(output / name) for name in expected}
    for name, checksum in hashes.items():
        if not isinstance(checksum, str) or not HEX.fullmatch(checksum) or digest(contents[name]) != checksum:
            raise ValueError("Managed output was modified: " + name)
    if manifest.get("archiveSHA256") != hashes[archive] or manifest.get("archiveBytes") != len(contents[archive]):
        raise ValueError("Invalid managed output archive metadata")
    package_files = {}
    unpacked_size = 0
    with tarfile.open(fileobj=io.BytesIO(contents[archive]), mode="r:gz") as packed:
        for member in packed.getmembers():
            path = PurePosixPath(member.name)
            if (not member.isfile() or path.is_absolute() or ".." in path.parts
                    or not member.name.startswith("package/") or member.name in package_files
                    or member.mode != 0o644 or member.mtime != 0 or member.uid != 0 or member.gid != 0
                    or member.uname or member.gname):
                raise ValueError("Invalid managed archive member: " + member.name)
            data = packed.extractfile(member).read()
            package_files[member.name] = digest(data)
            unpacked_size += len(data)
            if member.name == "package/package.json":
                package = read_json(data)
                if (package.get("name") != manifest["package"] or package.get("version") != manifest["version"]
                        or package.get("peerDependencies", {}).get("@deepseek-ai/dsh-agent") != manifest.get("dshVersionRange", manifest.get("dshVersion"))):
                    raise ValueError("Archive package metadata does not match manifest")
    if ("package/package.json" not in package_files
            or manifest.get("packageFilesSHA256") != package_files
            or manifest.get("packageFileCount") != len(package_files)
            or manifest.get("unpackedBytes") != unpacked_size):
        raise ValueError("Archive file inventory does not match manifest")
    checksums = "".join(digest(contents[name]) + "  " + name + "\n" for name in sorted(expected - {"SHA256SUMS"}))
    if contents["SHA256SUMS"] != checksums.encode("ascii"):
        raise ValueError("Managed output checksum file was modified")
    return manifest, {name: digest(data) for name, data in contents.items()}


def package_bridge(source, output):
    source, package, dsh_version, files = collect(source)
    output = reject_symlinks(output)
    # A standalone project may use its reserved build/package directory. All
    # other source-overlapping outputs remain forbidden, including the project root.
    if output == source or output in source.parents or (source in output.parents and output != source / "build/package"):
        raise ValueError("Output and bridge source must not overlap")
    old_hashes = validate_output(output, allow_legacy=True)[1] if output.exists() else None
    archive = archive_name(PACKAGE, package["version"])
    payload = archive_bytes(files)
    dsh_range = package["peerDependencies"]["@deepseek-ai/dsh-agent"]
    readme = instructions(archive, package["version"], dsh_range)
    manifest = {
        "schemaVersion": 1, "generator": GENERATOR, "package": PACKAGE,
        "version": package["version"], "dshVersion": dsh_version,
        **({"dshVersionRange": dsh_range} if dsh_range.startswith(">=") else {}),
        "archive": archive, "archiveSHA256": digest(payload), "archiveBytes": len(payload),
        "unpackedBytes": sum(len(data) for data in files.values()),
        "packageFileCount": len(files),
        "filesSHA256": {archive: digest(payload), "README.md": digest(readme)},
        "packageFilesSHA256": {"package/" + name: digest(data) for name, data in sorted(files.items())},
    }
    contents = {archive: payload, "README.md": readme, "manifest.json": json_bytes(manifest)}
    contents["SHA256SUMS"] = "".join(digest(data) + "  " + name + "\n" for name, data in sorted(contents.items())).encode("ascii")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".agentpet-dsh-stage-", dir=output.parent))
    backup = None
    try:
        for name, data in contents.items():
            (stage / name).write_bytes(data)
        validate_output(stage)
        if output.exists():
            if old_hashes is None or validate_output(output, allow_legacy=True)[1] != old_hashes:
                raise ValueError("Output changed while packaging; leaving it untouched")
            backup = Path(tempfile.mkdtemp(prefix=".agentpet-dsh-before-", dir=output.parent))
            backup.rmdir()
            output.rename(backup)
        elif old_hashes is not None:
            raise ValueError("Output disappeared while packaging")
        try:
            stage.rename(output)
        except BaseException:
            if backup is not None and not output.exists():
                backup.rename(output)
                backup = None
            raise
        if backup is not None:
            # Revalidate before deleting the tool-owned old copy; unexpected data stays.
            if validate_output(backup, allow_legacy=True)[1] != old_hashes:
                raise ValueError("Previous output changed; preserved at " + str(backup))
            shutil.rmtree(backup)
            backup = None
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return manifest


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=repo)
    parser.add_argument("--output-dir", type=Path, default=repo / "build/package")
    parser.add_argument("--verify", action="store_true", help="Verify an existing output without packaging")
    args = parser.parse_args()
    try:
        manifest = validate_output(args.output_dir)[0] if args.verify else package_bridge(args.source_dir, args.output_dir)
    except (OSError, ValueError, TypeError, KeyError, tarfile.TarError) as error:
        raise SystemExit("DSH bridge packaging refused: " + str(error))
    print(json.dumps({key: manifest[key] for key in ("package", "version", "dshVersion", "archive", "archiveSHA256")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
