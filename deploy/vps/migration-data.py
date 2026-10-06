#!/usr/bin/env python3
"""Offline, private VARGI volume migration; Python 3 standard library only.

Stop/quiesce the sole API process before export, including maintenance and
in-flight uploads. --offline-confirmed is an operator acknowledgement, not a
remote lock. Never publish the resulting archive or store it in a public repo.
The known .last-backup-date runtime marker is checked but deliberately omitted.
"""

import argparse
import base64
import ctypes
import errno
import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path


MAX_BYTES = 4 * 1024**3
MAX_ENTRIES = 100_000
MAX_JSON_BYTES = 4 * 1024**2
MAX_METADATA_BYTES = 16 * 1024**2
MAX_METADATA_ENTRY = 64 * 1024
CHUNK = 1024 * 1024
ID_RE = re.compile(r"[0-9TZ_-]{20,80}_[a-f0-9]{8}\Z")
PHOTO_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}\Z")
STATUSES = ("pending", "published", "sold", "archived", "rejected", "trash")
CONFIG_FILES = ("admin-auth.json", "telegram-notify.json")
PAX_KEYS = {
    "path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname",
    "gname", "charset", "comment", "SCHILY.dev", "SCHILY.ino", "SCHILY.nlink",
}


class MigrationError(Exception):
    """A fixed, non-sensitive error code; never include paths or data values."""


def fail(code):
    raise MigrationError(code)


def absolute(path):
    # Do not resolve() first: doing so would conceal a symlink in the input.
    return Path(os.path.abspath(os.fspath(path)))


def check_ancestors(path, include_leaf=True):
    path = absolute(path)
    parts = list(reversed(path.parents)) + ([path] if include_leaf else [])
    for part in parts:
        try:
            info = part.lstat()
        except OSError:
            fail("missing_or_inaccessible_path")
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            fail("unsafe_directory_path")


def regular_stat(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        fail("non_regular_or_linked_file")
    return info


def open_regular(path):
    expected = regular_stat(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    actual = os.fstat(fd)
    if (not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1 or
            (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino)):
        os.close(fd)
        fail("file_changed_or_linked")
    return os.fdopen(fd, "rb")


def stable_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def safe_photo(name):
    return (isinstance(name, str) and bool(PHOTO_RE.fullmatch(name)) and
            name != "submission.json" and name not in (".", ".."))


def bounded_children(folder):
    entries = []
    for entry in folder.iterdir():
        entries.append(entry)
        if len(entries) > MAX_ENTRIES:
            fail("entry_count_limit")
    return entries


def decode_json(raw):
    if len(raw) > MAX_JSON_BYTES:
        fail("json_size_limit")
    try:
        # Duplicate JSON keys can conceal an ID, status or filename.
        def unique_keys(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    fail("duplicate_json_key")
                result[key] = value
            return result

        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_keys,
                           parse_constant=lambda _: fail("invalid_json_number"))
    except (UnicodeError, ValueError, RecursionError):
        fail("invalid_json")
    if not isinstance(value, dict):
        fail("invalid_json_object")
    return value


def validate_config(name, raw):
    value = decode_json(raw)
    if name == "admin-auth.json":
        try:
            valid = (value.get("version") == 1 and
                     isinstance(value.get("salt"), str) and
                     isinstance(value.get("hash"), str) and
                     len(base64.b64decode(value["salt"], validate=True)) == 16 and
                     len(base64.b64decode(value["hash"], validate=True)) == 64)
        except (ValueError, TypeError):
            valid = False
        if not valid:
            fail("invalid_admin_auth")
    else:
        chat = value.get("chatId")
        if isinstance(chat, bool) or not (
                isinstance(chat, int) or
                (isinstance(chat, str) and re.fullmatch(r"-?[0-9]{1,30}", chat))):
            fail("invalid_telegram_config")
        if "chatLabel" in value and not isinstance(value["chatLabel"], str):
            fail("invalid_telegram_config")


def validate_submission(value, directory_id):
    if value.get("id") != directory_id or value.get("status") not in STATUSES:
        fail("invalid_submission_identity_or_status")
    photos = value.get("photos")
    if not isinstance(photos, list):
        fail("invalid_photo_list")
    names = []
    for photo in photos:
        if not isinstance(photo, dict) or not safe_photo(photo.get("filename")):
            fail("invalid_photo_filename")
        names.append(photo["filename"])
    if len(names) != len(set(names)):
        fail("duplicate_photo_reference")
    # Legacy submissions may predate persisted retry fields. Keep their bytes.
    legacy = "requestId" not in value or "requestHash" not in value
    if "requestId" in value and not isinstance(value["requestId"], str):
        fail("invalid_request_metadata")
    if "requestHash" in value and not isinstance(value["requestHash"], str):
        fail("invalid_request_metadata")
    return names, legacy


def fingerprint(records):
    result = hashlib.sha256()
    for name in sorted(records):
        size, digest = records[name]
        result.update(name.encode("utf-8") + b"\0" + str(size).encode("ascii") +
                      b"\0" + digest.encode("ascii") + b"\n")
    return result.hexdigest()


@dataclass
class Snapshot:
    records: dict
    directories: set
    summary: dict


def scan_data(data_root):
    root = absolute(data_root)
    check_ancestors(root)
    records, directories = {}, set()
    total_bytes = 0
    node_count = 0
    ignored = 0
    counts = {status: 0 for status in STATUSES}
    photo_count = 0
    legacy_count = 0

    def account_node():
        nonlocal node_count
        node_count += 1
        if node_count > MAX_ENTRIES:
            fail("entry_count_limit")

    def read_file(path, relative, as_json=False):
        nonlocal total_bytes
        account_node()
        with open_regular(path) as source:
            before = os.fstat(source.fileno())
            if before.st_size > MAX_BYTES or (as_json and before.st_size > MAX_JSON_BYTES):
                fail("file_size_limit")
            digest = hashlib.sha256()
            raw = bytearray() if as_json else None
            size = 0
            while True:
                block = source.read(CHUNK)
                if not block:
                    break
                size += len(block)
                total_bytes += len(block)
                if total_bytes > MAX_BYTES or (as_json and size > MAX_JSON_BYTES):
                    fail("data_size_limit")
                digest.update(block)
                if as_json:
                    raw.extend(block)
            after = os.fstat(source.fileno())
            if stable_identity(before) != stable_identity(after) or size != before.st_size:
                fail("data_changed_during_scan")
        records[relative] = (size, digest.hexdigest())
        return bytes(raw) if as_json else None

    children = {entry.name: entry for entry in bounded_children(root)}
    unknown = set(children) - {"submissions", *CONFIG_FILES, ".last-backup-date"}
    if unknown:
        fail("unknown_data_root_entry")
    submissions = children.get("submissions")
    if submissions is None:
        fail("missing_submissions_directory")
    check_ancestors(submissions)
    account_node()
    directories.add("submissions")
    if ".last-backup-date" in children:
        regular_stat(children[".last-backup-date"])
        ignored = 1

    for name in CONFIG_FILES:
        if name in children:
            validate_config(name, read_file(children[name], name, True))

    for folder in sorted(bounded_children(submissions), key=lambda item: item.name):
        if not ID_RE.fullmatch(folder.name):
            fail("unknown_submission_entry")
        check_ancestors(folder)
        account_node()
        relative_dir = "submissions/" + folder.name
        directories.add(relative_dir)
        files = {entry.name: entry for entry in bounded_children(folder)}
        if "submission.json" not in files:
            fail("missing_submission_metadata")
        value = decode_json(read_file(files["submission.json"], relative_dir + "/submission.json", True))
        photo_names, legacy = validate_submission(value, folder.name)
        if set(files) != {"submission.json", *photo_names}:
            fail("missing_photo_or_unknown_submission_file")
        for name in sorted(photo_names):
            read_file(files[name], relative_dir + "/" + name)
        photo_count += len(photo_names)
        legacy_count += int(legacy)
        counts[value["status"]] += 1

    summary = {
        "sha256": fingerprint(records),
        "files": len(records),
        "bytes": total_bytes,
        "submissions": sum(counts.values()),
        "photos": photo_count,
        "byStatus": counts,
        "legacyRequestFieldsMissing": legacy_count,
        "adminAuthPresent": "admin-auth.json" in records,
        "telegramConfigPresent": "telegram-notify.json" in records,
        "ignoredRuntimeFiles": ignored,
    }
    return Snapshot(records, directories, summary)


class HashingReader:
    def __init__(self, source):
        self.source = source
        self.digest = hashlib.sha256()
        self.size = 0

    def read(self, size=-1):
        block = self.source.read(size)
        self.digest.update(block)
        self.size += len(block)
        return block


def export_data(data_root, archive, offline_confirmed=False):
    if not offline_confirmed:
        fail("offline_confirmation_required")
    root, output = absolute(data_root), absolute(archive)
    if root == output or root in output.parents:
        fail("archive_must_be_outside_data_root")
    check_ancestors(output, include_leaf=False)
    if os.path.lexists(output):
        fail("archive_destination_exists")
    initial = scan_data(root)
    fd, temporary = tempfile.mkstemp(prefix=".vargi-export-", dir=output.parent)
    temporary = Path(temporary)
    os.chmod(temporary, 0o600)
    captured = {}
    try:
        with os.fdopen(fd, "wb") as destination:
            with tarfile.open(fileobj=destination, mode="w:gz", format=tarfile.PAX_FORMAT) as archive_file:
                for name in sorted(initial.directories):
                    member = tarfile.TarInfo(name + "/")
                    member.type = tarfile.DIRTYPE
                    member.mode = 0o700
                    archive_file.addfile(member)
                for name in sorted(initial.records):
                    with open_regular(root / name) as source:
                        before = os.fstat(source.fileno())
                        member = tarfile.TarInfo(name)
                        member.mode = 0o600
                        member.size = before.st_size
                        reader = HashingReader(source)
                        archive_file.addfile(member, reader)
                        if stable_identity(before) != stable_identity(os.fstat(source.fileno())):
                            fail("data_changed_during_export")
                        captured[name] = (reader.size, reader.digest.hexdigest())
            destination.flush()
            os.fsync(destination.fileno())
        final = scan_data(root)
        if (initial.records != captured or initial.records != final.records or
                initial.directories != final.directories):
            fail("data_changed_during_export")
        if temporary.stat().st_size > MAX_BYTES:
            fail("archive_size_limit")
        # link() publishes the complete archive without replacing an existing path.
        os.link(temporary, output, follow_symlinks=False)
        temporary.unlink()
        return initial.summary
    finally:
        if temporary.exists():
            temporary.unlink()


class SafeTarInfo(tarfile.TarInfo):
    def _proc_gnusparse_00(self, *args):
        fail("archive_links_or_special_files_forbidden")

    _proc_gnusparse_01 = _proc_gnusparse_00
    _proc_gnusparse_10 = _proc_gnusparse_00

    def _proc_member(self, archive_file):
        # Bound extended headers before stdlib tar allocates their payloads.
        count = getattr(archive_file, "migration_header_count", 0) + 1
        archive_file.migration_header_count = count
        if count > MAX_ENTRIES:
            fail("entry_count_limit")
        metadata_types = (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE,
                          tarfile.GNUTYPE_LONGNAME)
        if self.type in metadata_types:
            size = getattr(archive_file, "migration_metadata_bytes", 0) + self.size
            archive_file.migration_metadata_bytes = size
            if self.size < 0 or self.size > MAX_METADATA_ENTRY or size > MAX_METADATA_BYTES:
                fail("archive_metadata_size_limit")
        elif not (self.isreg() or self.isdir()):
            fail("archive_links_or_special_files_forbidden")
        elif self.size < 0 or self.size > MAX_BYTES or (self.isdir() and self.size != 0):
            fail("archive_member_size_limit")
        return super()._proc_member(archive_file)


class BoundedReader:
    def __init__(self, source):
        self.source = source
        self.size = 0

    def read(self, size=-1):
        if size < 0:
            fail("unbounded_archive_read")
        block = self.source.read(size)
        self.size += len(block)
        limit = MAX_BYTES + MAX_ENTRIES * 1024 + MAX_METADATA_BYTES + CHUNK
        if self.size > limit:
            fail("expanded_archive_size_limit")
        return block


def archive_path(member):
    name = member.name
    if (not isinstance(name, str) or not name or name.startswith("/") or
            "\\" in name or "\0" in name or re.match(r"^[A-Za-z]:", name)):
        fail("unsafe_archive_path")
    if member.isdir() and name.endswith("/"):
        name = name[:-1]
    components = name.split("/")
    if any(piece in ("", ".", "..") for piece in components):
        fail("unsafe_archive_path")
    if name in CONFIG_FILES and member.isreg():
        return name
    if components[0] != "submissions":
        fail("unknown_archive_root")
    if len(components) == 1 and member.isdir():
        return name
    if len(components) >= 2 and ID_RE.fullmatch(components[1]):
        if len(components) == 2 and member.isdir():
            return name
        if len(components) == 3 and member.isreg() and (
                components[2] == "submission.json" or safe_photo(components[2])):
            return name
    fail("unknown_archive_entry")


def scan_archive(archive, target=None):
    archive = absolute(archive)
    check_ancestors(archive, include_leaf=False)
    records, directories, seen = {}, set(), set()
    total_bytes = 0
    with open_regular(archive) as original:
        if os.fstat(original.fileno()).st_size > MAX_BYTES:
            fail("archive_size_limit")
        magic = original.read(2)
        original.seek(0)
        decoded = gzip.GzipFile(fileobj=original) if magic == b"\x1f\x8b" else original
        bounded = BoundedReader(decoded)
        try:
            with tarfile.open(fileobj=bounded, mode="r|", tarinfo=SafeTarInfo) as archive_file:
                for member in archive_file:
                    if not (member.isreg() or member.isdir()) or member.linkname or member.sparse:
                        fail("archive_links_or_special_files_forbidden")
                    if set(member.pax_headers) - PAX_KEYS:
                        fail("unsupported_archive_metadata")
                    if member.isreg() and member.pax_headers.get("SCHILY.nlink", "1") != "1":
                        fail("archive_links_or_special_files_forbidden")
                    if member.size < 0 or member.size > MAX_BYTES:
                        fail("archive_member_size_limit")
                    name = archive_path(member)
                    if name.endswith(".json") and member.size > MAX_JSON_BYTES:
                        fail("json_size_limit")
                    if name in seen:
                        fail("duplicate_archive_path")
                    seen.add(name)
                    if len(seen) > MAX_ENTRIES:
                        fail("entry_count_limit")
                    if member.isdir():
                        directories.add(name)
                        if target is not None:
                            (target / name).mkdir(mode=0o700, parents=True, exist_ok=True)
                        continue
                    total_bytes += member.size
                    if total_bytes > MAX_BYTES:
                        fail("data_size_limit")
                    digest, size = hashlib.sha256(), 0
                    output = None
                    try:
                        if target is not None:
                            output_path = target / name
                            output_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
                            output = os.fdopen(os.open(output_path, flags, 0o600), "wb")
                        source = archive_file.extractfile(member)
                        if source is None:
                            fail("missing_archive_payload")
                        with source:
                            while True:
                                block = source.read(CHUNK)
                                if not block:
                                    break
                                size += len(block)
                                if size > member.size:
                                    fail("archive_payload_size_mismatch")
                                digest.update(block)
                                if output is not None:
                                    output.write(block)
                        if size != member.size:
                            fail("archive_payload_size_mismatch")
                        if output is not None:
                            output.flush()
                            os.fsync(output.fileno())
                    finally:
                        if output is not None:
                            output.close()
                    records[name] = (size, digest.hexdigest())
                # Consume buffered remainder too; reject concatenated hidden tar
                # entries and verify the gzip trailer/CRC instead of ignoring it.
                while True:
                    block = archive_file.fileobj.read(CHUNK)
                    if not block:
                        break
                    if block.strip(b"\0"):
                        fail("nonzero_archive_trailer")
        finally:
            if decoded is not original:
                decoded.close()
    if "submissions" not in directories and not any(
            name.startswith("submissions/") for name in records):
        fail("missing_submissions_directory")
    return records, directories


def atomic_move_directory(source, target):
    if os.name == "nt":
        # Windows rename refuses an existing destination.
        os.rename(source, target)
        return
    if not sys.platform.startswith("linux"):
        fail("atomic_no_replace_requires_linux_or_windows")
    # Linux host: RENAME_NOREPLACE prevents even a concurrent empty directory
    # from being overwritten. ctypes is part of the Python standard library.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        fail("atomic_no_replace_unavailable")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            fail("data_destination_exists")
        fail("atomic_import_move_failed")


def import_data(archive, new_data_root):
    target = absolute(new_data_root)
    check_ancestors(target, include_leaf=False)
    if os.path.lexists(target):
        fail("data_destination_exists")
    expected_records, expected_directories = scan_archive(archive)
    temporary = Path(tempfile.mkdtemp(prefix=".vargi-import-", dir=target.parent))
    os.chmod(temporary, 0o700)
    try:
        captured_records, captured_directories = scan_archive(archive, temporary)
        if (expected_records != captured_records or
                expected_directories != captured_directories):
            fail("archive_changed_during_import")
        snapshot = scan_data(temporary)
        if snapshot.records != expected_records:
            fail("import_fingerprint_mismatch")
        if os.path.lexists(target):
            fail("data_destination_exists")
        atomic_move_directory(temporary, target)
        return snapshot.summary
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


class PrivateArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        fail("invalid_arguments")


def main(argv=None):
    parser = PrivateArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    verify = subcommands.add_parser("verify", help="Validate data without printing record contents or paths")
    verify.add_argument("data_root")
    export = subcommands.add_parser("export", help="Export a stopped/quiescent API volume to a private .tgz")
    export.add_argument("data_root")
    export.add_argument("archive")
    export.add_argument("--offline-confirmed", action="store_true")
    importer = subcommands.add_parser("import", help="Validate/import into a NEW, nonexistent data directory")
    importer.add_argument("archive")
    importer.add_argument("new_data_root")
    try:
        args = parser.parse_args(argv)
        if args.command == "verify":
            summary = scan_data(args.data_root).summary
        elif args.command == "export":
            summary = export_data(args.data_root, args.archive, args.offline_confirmed)
        else:
            summary = import_data(args.archive, args.new_data_root)
        print(json.dumps({"ok": True, "operation": args.command, **summary}, sort_keys=True))
        return 0
    except MigrationError as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        return 1
    except (OSError, EOFError, tarfile.TarError, ValueError, RecursionError):
        print(json.dumps({"ok": False, "error": "filesystem_or_archive_error"}), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print(json.dumps({"ok": False, "error": "interrupted"}), file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
