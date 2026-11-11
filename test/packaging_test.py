#!/usr/bin/env python3
"""Isolated distribution/overwrite checks; no DSH home, npm or network access."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PACK = load("dsh_bridge_packager", "package-bridge.py")



class BridgePackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentpet-dsh-packaging-")
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "source"
        self.output = self.root / "output"
        for name in ("lib", "third-party-licenses", "src", "test", "node_modules", ".build"):
            (self.source / name).mkdir(parents=True, exist_ok=True)
        package = {
            "name": PACK.PACKAGE, "version": "0.1.5", "main": "lib/index.js",
            "types": "lib/index.d.ts", "exports": {".": "./lib/index.js", "./package.json": "./package.json"},
            "peerDependencies": {"@deepseek-ai/dsh-agent": "0.2.0-rc.2"},
            "dsh": {"bundle": {"patch": "./cordis.patch.yml"}},
        }
        (self.source / "package.json").write_bytes(PACK.json_bytes(package))
        for name in PACK.ROOT_FILES - {"package.json"}:
            (self.source / name).write_text("Fixture " + name + "\n")
        (self.source / "lib/index.js").write_text("export { value } from './value.js';\n")
        (self.source / "lib/value.js").write_text("export const value = 1;\n")
        (self.source / "lib/index.d.ts").write_text("export declare const value: number;\n")
        for name in ("Zod-4.6.7-LICENSE.txt", "DSH-Typert-Protocol-0.2.1-rc.2-LICENSE.txt"):
            (self.source / "third-party-licenses" / name).write_text("Fixture MIT license\n")
        for name in ("src/not-runtime.ts", "test/not-runtime.test.js", "node_modules/secret", ".build/staging", "credentials.json"):
            (self.source / name).write_text("excluded development data\n")

    def tearDown(self):
        self.temp.cleanup()

    def packed(self):
        return PACK.package_bridge(self.source, self.output)

    def output_bytes(self):
        return {p.name: p.read_bytes() for p in self.output.iterdir()}

    def test_reproducible_archive_inventory_and_update(self):
        first = self.packed()
        before = self.output_bytes()
        for path in self.source.rglob("*"):
            if path.is_file():
                os.utime(path, (12345678, 12345678))
                path.chmod(0o700)
        self.assertEqual(self.packed(), first)
        self.assertEqual(self.output_bytes(), before)
        second = self.root / "another-output"
        PACK.package_bridge(self.source, second)
        self.assertEqual({p.name: p.read_bytes() for p in second.iterdir()}, before)
        self.assertEqual(set(before), {first["archive"], "README.md", "manifest.json", "SHA256SUMS"})
        self.assertEqual(set(first["filesSHA256"]), {first["archive"], "README.md"})
        with tarfile.open(fileobj=io.BytesIO(before[first["archive"]]), mode="r:gz") as archive:
            self.assertEqual(set(archive.getnames()), set(first["packageFilesSHA256"]))
            for member in archive:
                self.assertTrue(member.isfile())
                self.assertEqual((member.uid, member.gid, member.mtime, member.mode), (0, 0, 0, 0o644))
                data = archive.extractfile(member).read()
                self.assertEqual(hashlib.sha256(data).hexdigest(), first["packageFilesSHA256"][member.name])
        self.assertFalse(any("node_modules" in name or "src/" in name or "test/" in name for name in first["packageFilesSHA256"]))

    def test_known_output_can_upgrade_without_leaving_old_archive(self):
        self.packed()
        package = json.loads((self.source / "package.json").read_text())
        package["version"] = "0.1.6"
        (self.source / "package.json").write_bytes(PACK.json_bytes(package))
        result = self.packed()
        self.assertEqual(result["version"], "0.1.6")
        self.assertFalse((self.output / "agentpet-lite-dsh-bridge-0.1.5.tgz").exists())
        PACK.validate_output(self.output)

    def test_minimum_runtime_range_survives_packaging_and_verification(self):
        path = self.source / "package.json"
        package = json.loads(path.read_text())
        package["peerDependencies"] = {name: ">=0.2.1-rc.2" for name in [
            "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-client-ui-session",
            "@deepseek-ai/dsh-client-ui-workspace", "@deepseek-ai/dsh-typert-protocol",
        ]}
        package["engines"] = {"dsh": ">=0.2.1-rc.2"}
        path.write_bytes(PACK.json_bytes(package))
        result = self.packed()
        self.assertEqual(result["dshVersion"], "0.2.1-rc.2")
        self.assertEqual(result["dshVersionRange"], ">=0.2.1-rc.2")
        self.assertEqual(PACK.validate_output(self.output)[0], result)
        self.assertIn(">=0.2.1-rc.2", (self.output / "README.md").read_text())

    def test_inconsistent_or_unbounded_runtime_requirements_are_rejected(self):
        path = self.source / "package.json"
        original = json.loads(path.read_text())
        for peers, engines in [
            ({"@deepseek-ai/dsh-agent": "*"}, {}),
            ({"@deepseek-ai/dsh-agent": ">=0.2.1-rc.2", "@deepseek-ai/dsh-client-ui-session": "0.2.1-rc.2"}, {}),
            ({"@deepseek-ai/dsh-agent": ">=0.2.1-rc.2"}, {"dsh": "0.2.1-rc.2"}),
        ]:
            with self.subTest(peers=peers, engines=engines):
                package = {**original, "peerDependencies": peers, "engines": engines}
                path.write_bytes(PACK.json_bytes(package))
                with self.assertRaises(ValueError):
                    self.packed()

    def test_intact_legacy_managed_output_migrates_but_tampered_output_is_preserved(self):
        manifest_path = self.source / "package.json"
        package = json.loads(manifest_path.read_text())
        package.update(name=PACK.LEGACY_PACKAGE, version="0.1.4")
        manifest_path.write_bytes(PACK.json_bytes(package))
        with patch.object(PACK, "PACKAGE", PACK.LEGACY_PACKAGE):
            legacy = self.packed()
        with self.assertRaises(ValueError):
            PACK.validate_output(self.output)
        self.assertEqual(PACK.validate_output(self.output, allow_legacy=True)[0], legacy)
        package.update(name=PACK.PACKAGE, version="0.1.5")
        manifest_path.write_bytes(PACK.json_bytes(package))
        readme = self.output / "README.md"
        original = readme.read_bytes()
        readme.write_bytes(original + b"modified")
        before = self.output_bytes()
        with self.assertRaises(ValueError):
            self.packed()
        self.assertEqual(self.output_bytes(), before)
        readme.write_bytes(original)
        current = self.packed()
        self.assertEqual(current["package"], "@agentpet-lite/dsh-bridge")
        self.assertEqual(current["archive"], "agentpet-lite-dsh-bridge-0.1.5.tgz")
        self.assertFalse((self.output / legacy["archive"]).exists())
        PACK.validate_output(self.output)

    def test_unknown_directory_is_never_deleted(self):
        self.output.mkdir()
        (self.output / "personal-data").write_text("keep me")
        with self.assertRaises((ValueError, OSError)):
            self.packed()
        self.assertEqual((self.output / "personal-data").read_text(), "keep me")

    def test_tampered_or_extra_output_is_preserved(self):
        for name in ("README.md", "manifest.json", "SHA256SUMS", "extra-data"):
            with self.subTest(name=name):
                if self.output.exists():
                    shutil.rmtree(self.output)
                self.packed()
                with (self.output / name).open("ab") as file:
                    file.write(b"changed")
                before = self.output_bytes()
                with self.assertRaises((ValueError, OSError)):
                    self.packed()
                self.assertEqual(self.output_bytes(), before)

    def test_source_or_output_overlap_is_rejected(self):
        for output in (self.source, self.source / "out", self.root):
            with self.subTest(output=output), self.assertRaises(ValueError):
                PACK.package_bridge(self.source, output)
        self.assertEqual((self.source / "README.md").read_text(), "Fixture README.md\n")

    def test_symlinks_and_hard_links_are_rejected(self):
        alias = self.root / "source-alias"
        alias.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(ValueError):
            PACK.package_bridge(alias, self.output)
        member = self.source / "lib/value.js"
        data = member.read_bytes()
        member.unlink()
        member.symlink_to(self.source / "README.md")
        with self.assertRaises(ValueError):
            self.packed()
        member.unlink()
        member.write_bytes(data)
        os.link(member, self.root / "same-inode")
        with self.assertRaises(ValueError):
            self.packed()
        (self.root / "same-inode").unlink()
        lib = self.source / "lib"
        lib.rename(self.root / "linked-lib")
        lib.symlink_to(self.root / "linked-lib", target_is_directory=True)
        with self.assertRaises(ValueError):
            self.packed()
        out_parent = self.root / "output-parent"
        out_parent.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            PACK.package_bridge(self.source, out_parent / "out")

    def test_runtime_entries_and_license_files_are_required(self):
        for name in ("lib/index.js", "lib/value.js", "lib/index.d.ts", "LICENSE", "THIRD_PARTY_NOTICES.md",
                     "third-party-licenses/Zod-4.6.7-LICENSE.txt",
                     "third-party-licenses/DSH-Typert-Protocol-0.2.1-rc.2-LICENSE.txt"):
            with self.subTest(name=name):
                path = self.source / name
                data = path.read_bytes()
                path.unlink()
                with self.assertRaises((ValueError, OSError)):
                    self.packed()
                self.assertFalse(self.output.exists())
                path.write_bytes(data)

    def test_machine_paths_and_unexpected_runtime_files_are_rejected(self):
        for name, data in (("lib/leak.js", b"const p = '/Users/example/private';"), ("lib/cache.tsbuildinfo", b"private")):
            with self.subTest(name=name):
                path = self.source / name
                path.write_bytes(data)
                with self.assertRaises(ValueError):
                    self.packed()
                path.unlink()
        self.assertFalse(self.output.exists())

    def test_forged_package_inventory_is_detected(self):
        self.packed()
        manifest_path = self.output / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["packageFilesSHA256"]["package/lib/index.js"] = "0" * 64
        manifest_path.write_bytes(PACK.json_bytes(manifest))
        paths = sorted(p for p in self.output.iterdir() if p.name != "SHA256SUMS")
        (self.output / "SHA256SUMS").write_text("".join(PACK.digest(p.read_bytes()) + "  " + p.name + "\n" for p in paths))
        with self.assertRaises(ValueError):
            PACK.validate_output(self.output)



if __name__ == "__main__":
    unittest.main(verbosity=2)
