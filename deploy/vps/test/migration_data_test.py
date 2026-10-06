"""Synthetic-only tests: no production files, credentials, or external calls."""

import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "migration-data.py"
SPEC = importlib.util.spec_from_file_location("vargi_migration_data", SCRIPT)
M = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = M
SPEC.loader.exec_module(M)
FIRST_ID = "2026-10-06T10-00-00-000Z_1234abcd"
SECOND_ID = "2026-10-06T11-00-00-000Z_5678abcd"


class MigrationDataTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.base = Path(self.workspace.name)
        self.root = self.base / "source"
        self.root.mkdir(mode=0o700)
        (self.root / "submissions").mkdir(mode=0o700)
        self.add_item(FIRST_ID, "published")
        self.add_item(SECOND_ID, "trash", legacy=True)
        auth = {
            "version": 1,
            "salt": base64.b64encode(b"0123456789abcdef").decode(),
            "hash": base64.b64encode(b"x" * 64).decode(),
            "createdAt": "2026-10-06T10:00:00Z",
        }
        (self.root / "admin-auth.json").write_bytes(json.dumps(auth, indent=1).encode())
        (self.root / "telegram-notify.json").write_bytes(
            b'{"chatId":-123456,"chatLabel":"SYNTHETIC_PRIVATE_LABEL","connectedAt":"2026-10-06"}\n')
        (self.root / ".last-backup-date").write_bytes(b"2026-10-06\n")
        self.archive = self.base / "snapshot.tgz"

    def add_item(self, identity, status, legacy=False):
        folder = self.root / "submissions" / identity
        folder.mkdir(mode=0o700)
        item = {
            "id": identity, "status": status, "title": "SYNTHETIC_PRIVATE_TITLE",
            "contact": "SYNTHETIC_PRIVATE_CONTACT", "consent": {"accepted": True},
            "createdAt": "2026-10-06T10:00:00Z",
            "photos": [{"filename": "photo-01.jpg", "mimeType": "image/jpeg"}],
        }
        if status == "trash":
            item.update(previousStatus="sold", deletedAt="2026-10-05T09:00:00Z")
        if not legacy:
            item.update(requestId="synthetic-retry-id", requestHash="synthetic-hash")
        (folder / "submission.json").write_bytes(json.dumps(item, indent=3).encode() + b"\n")
        (folder / "photo-01.jpg").write_bytes(b"\xff\xd8\xffSYNTHETIC_IMAGE\xff\xd9")
        return folder

    def metadata(self, identity=FIRST_ID):
        return self.root / "submissions" / identity / "submission.json"

    def change_metadata(self, updater, identity=FIRST_ID):
        path = self.metadata(identity)
        value = json.loads(path.read_bytes())
        updater(value)
        path.write_bytes(json.dumps(value).encode())

    def malicious_archive(self, members):
        archive = self.base / "malicious.tgz"
        with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as output:
            for name, kind, contents in members:
                info = tarfile.TarInfo(name)
                info.type = kind
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    info.linkname = contents
                    output.addfile(info)
                elif kind == tarfile.DIRTYPE:
                    output.addfile(info)
                else:
                    info.size = len(contents)
                    output.addfile(info, io.BytesIO(contents))
        return archive

    def test_roundtrip_preserves_all_bytes_and_private_permissions(self):
        before = M.scan_data(self.root)
        exported = M.export_data(self.root, self.archive, True)
        destination = self.base / "imported"
        imported = M.import_data(self.archive, destination)
        self.assertEqual(before.records, M.scan_data(destination).records)
        self.assertEqual(exported["sha256"], imported["sha256"])
        self.assertEqual(imported["submissions"], 2)
        self.assertEqual(imported["byStatus"]["trash"], 1)
        self.assertEqual(imported["legacyRequestFieldsMissing"], 1)
        self.assertTrue(imported["adminAuthPresent"])
        self.assertTrue(imported["telegramConfigPresent"])
        self.assertFalse((destination / ".last-backup-date").exists())
        self.assertEqual(stat.S_IMODE(self.archive.stat().st_mode), 0o600)
        for path in [destination, *destination.rglob("*")]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)
        for name in before.records:
            self.assertEqual((self.root / name).read_bytes(), (destination / name).read_bytes())

    def test_export_requires_offline_confirmation_and_refuses_overwrite(self):
        with self.assertRaisesRegex(M.MigrationError, "offline_confirmation_required"):
            M.export_data(self.root, self.archive)
        self.archive.write_bytes(b"must survive")
        with self.assertRaisesRegex(M.MigrationError, "archive_destination_exists"):
            M.export_data(self.root, self.archive, True)
        self.assertEqual(self.archive.read_bytes(), b"must survive")

    def test_import_refuses_existing_empty_and_nonempty_directories(self):
        M.export_data(self.root, self.archive, True)
        destination = self.base / "already-there"
        destination.mkdir()
        with self.assertRaisesRegex(M.MigrationError, "data_destination_exists"):
            M.import_data(self.archive, destination)
        (destination / "keep").write_bytes(b"untouched")
        with self.assertRaisesRegex(M.MigrationError, "data_destination_exists"):
            M.import_data(self.archive, destination)
        self.assertEqual((destination / "keep").read_bytes(), b"untouched")

    def test_atomic_import_refuses_concurrently_created_empty_target(self):
        M.export_data(self.root, self.archive, True)
        destination = self.base / "race-target"
        original_move = M.atomic_move_directory

        def race_move(source, target):
            target.mkdir()
            original_move(source, target)

        with mock.patch.object(M, "atomic_move_directory", side_effect=race_move):
            with self.assertRaises(M.MigrationError):
                M.import_data(self.archive, destination)
        self.assertTrue(destination.is_dir())
        self.assertEqual(list(destination.iterdir()), [])
        self.assertFalse(list(self.base.glob(".vargi-import-*")))

    def test_rejects_corrupt_and_duplicate_key_json(self):
        for raw in [b"{broken", b'{"id":"x","id":"y"}', b'{"value":NaN}']:
            with self.subTest(raw=raw):
                self.metadata().write_bytes(raw)
                with self.assertRaises(M.MigrationError):
                    M.scan_data(self.root)

    def test_rejects_missing_photo_and_unknown_files(self):
        photo = self.metadata().parent / "photo-01.jpg"
        original = photo.read_bytes()
        photo.unlink()
        with self.assertRaisesRegex(M.MigrationError, "missing_photo"):
            M.scan_data(self.root)
        photo.write_bytes(original)
        (self.root / "environment.env").write_bytes(b"SYNTHETIC_ONLY")
        with self.assertRaisesRegex(M.MigrationError, "unknown_data_root_entry"):
            M.scan_data(self.root)

    def test_rejects_bad_photo_reference_id_and_status(self):
        original = self.metadata().read_bytes()
        changes = [
            lambda item: item["photos"][0].update(filename="../admin-auth.json"),
            lambda item: item["photos"].append(dict(item["photos"][0])),
            lambda item: item.update(id=SECOND_ID),
            lambda item: item.update(status="unknown"),
        ]
        for change in changes:
            with self.subTest(change=change):
                self.metadata().write_bytes(original)
                self.change_metadata(change)
                with self.assertRaises(M.MigrationError):
                    M.scan_data(self.root)

    def test_rejects_source_symlinks_and_hardlinks(self):
        photo = self.metadata().parent / "photo-01.jpg"
        other = self.base / "other.jpg"
        other.write_bytes(photo.read_bytes())
        photo.unlink()
        photo.symlink_to(other)
        with self.assertRaisesRegex(M.MigrationError, "non_regular_or_linked_file"):
            M.scan_data(self.root)
        photo.unlink()
        os.link(other, photo)
        with self.assertRaisesRegex(M.MigrationError, "non_regular_or_linked_file"):
            M.scan_data(self.root)

    def test_rejects_symlinked_source_root_and_destination_parent(self):
        alias = self.base / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(M.MigrationError, "unsafe_directory_path"):
            M.scan_data(alias)
        M.export_data(self.root, self.archive, True)
        with self.assertRaisesRegex(M.MigrationError, "unsafe_directory_path"):
            M.import_data(self.archive, alias / "new")

    def test_rejects_unsafe_archive_paths_without_creating_target(self):
        paths = ["../escaped", "/escaped", "C:/escaped", "submissions/../escaped",
                 "submissions\\escaped", "./submissions", "unknown.json",
                 "submissions//" + FIRST_ID + "/submission.json"]
        for index, name in enumerate(paths):
            with self.subTest(name=name):
                archive = self.malicious_archive([(name, tarfile.REGTYPE, b"no")])
                target = self.base / ("target-" + str(index))
                with self.assertRaises(M.MigrationError):
                    M.import_data(archive, target)
                self.assertFalse(target.exists())
        self.assertFalse((self.base.parent / "escaped").exists())

    def test_rejects_tar_symlink_hardlink_special_and_duplicate_entries(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE]:
            with self.subTest(kind=kind):
                payload = "../outside" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else b""
                archive = self.malicious_archive([
                    ("submissions/" + FIRST_ID + "/photo-01.jpg", kind, payload)])
                with self.assertRaises(M.MigrationError):
                    M.import_data(archive, self.base / "target")
        archive = self.malicious_archive([
            ("submissions", tarfile.DIRTYPE, b""),
            ("submissions/", tarfile.DIRTYPE, b""),
        ])
        with self.assertRaisesRegex(M.MigrationError, "duplicate_archive_path"):
            M.import_data(archive, self.base / "target")

    def test_fingerprint_changes_with_content_and_covers_config_files(self):
        original = M.scan_data(self.root).summary["sha256"]
        config = self.root / "telegram-notify.json"
        config.write_bytes(config.read_bytes().replace(b"-123456", b"-123457"))
        self.assertNotEqual(original, M.scan_data(self.root).summary["sha256"])

    def test_rejects_pax_sparse_before_parsing_payload(self):
        archive = self.base / "sparse.tgz"
        with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as output:
            member = tarfile.TarInfo("submissions/" + FIRST_ID + "/photo-01.jpg")
            member.pax_headers = {"GNU.sparse.major": "1", "GNU.sparse.minor": "0"}
            member.size = 3
            output.addfile(member, io.BytesIO(b"99\n"))
        with self.assertRaisesRegex(M.MigrationError, "special_files_forbidden"):
            M.scan_archive(archive)

    def test_accepts_legacy_daily_pax_metadata(self):
        archive = self.base / "legacy-daily.tgz"
        before = M.scan_data(self.root)
        with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as output:
            for name in sorted(before.directories):
                member = tarfile.TarInfo(name)
                member.type = tarfile.DIRTYPE
                member.pax_headers = {"mtime": "1720000000.125", "SCHILY.nlink": "2"}
                output.addfile(member)
            for name in before.records:
                raw = (self.root / name).read_bytes()
                member = tarfile.TarInfo(name)
                member.size = len(raw)
                member.pax_headers = {"mtime": "1720000000.125", "SCHILY.nlink": "1"}
                output.addfile(member, io.BytesIO(raw))
        imported = M.import_data(archive, self.base / "legacy-copy")
        self.assertEqual(imported["sha256"], before.summary["sha256"])

    def test_export_detects_concurrent_change_and_removes_partial_archive(self):
        original_scan = M.scan_data
        calls = 0

        def changing_scan(root):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.change_metadata(lambda item: item.update(title="changed during export"))
            return original_scan(root)

        with mock.patch.object(M, "scan_data", side_effect=changing_scan):
            with self.assertRaisesRegex(M.MigrationError, "data_changed_during_export"):
                M.export_data(self.root, self.archive, True)
        self.assertFalse(self.archive.exists())
        self.assertFalse(list(self.base.glob(".vargi-export-*")))

    def test_entry_and_size_limits(self):
        with mock.patch.object(M, "MAX_ENTRIES", 2):
            with self.assertRaisesRegex(M.MigrationError, "entry_count_limit"):
                M.scan_data(self.root)
        with mock.patch.object(M, "MAX_BYTES", 16):
            with self.assertRaises(M.MigrationError):
                M.scan_data(self.root)
        archive = self.malicious_archive([("submissions", tarfile.DIRTYPE, b"")])
        with mock.patch.object(M, "MAX_ENTRIES", 0):
            with self.assertRaisesRegex(M.MigrationError, "entry_count_limit"):
                M.scan_archive(archive)

    def test_anonymous_cli_summary_and_errors(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(M.main(["verify", str(self.root)]), 0)
        output = stdout.getvalue() + stderr.getvalue()
        self.assertNotIn("SYNTHETIC_PRIVATE", output)
        self.assertNotIn(FIRST_ID, output)
        self.assertNotIn(str(self.root), output)
        self.assertTrue(json.loads(stdout.getvalue())["ok"])
        self.metadata().write_bytes(b"broken SYNTHETIC_PRIVATE_CONTACT")
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(M.main(["verify", str(self.root)]), 1)
        self.assertEqual(json.loads(stderr.getvalue())["error"], "invalid_json")
        self.assertNotIn(str(self.root), stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
