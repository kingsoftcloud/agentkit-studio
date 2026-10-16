"""Deterministic ZIPs preserve exact package files and executable modes."""
import hashlib
import json
import pathlib
import stat
import sys
import zipfile

root, inventory_path, output = map(pathlib.Path, sys.argv[1:])
files = json.loads(inventory_path.read_text())
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for row in files:
        if not row["path"] or row["path"].startswith("/") or "\\" in row["path"] or any(part in {"", ".", ".."} for part in row["path"].split("/")):
            raise ValueError("Unsafe package path")
        path = root / row["path"]
        path.resolve().relative_to(root.resolve())
        if any(parent.is_symlink() for parent in [path, *path.parents] if parent != root.parent):
            raise ValueError("Package links are not publishable")
        data = path.read_bytes()
        if path.is_symlink() or not path.is_file() or len(data) != row["size"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise ValueError("Package changed before upload")
        entry = zipfile.ZipInfo(row["path"], date_time=(1980, 1, 1, 0, 0, 0))
        entry.create_system = 3
        entry.external_attr = (stat.S_IFREG | (0o700 if row.get("executable") else 0o600)) << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, data)
