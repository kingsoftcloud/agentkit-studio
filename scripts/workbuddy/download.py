#!/usr/bin/env python3
"""Snapshot the public WorkBuddy expert bundles; never installs or runs their contents."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import tempfile
import time
import urllib.request

BASE = 'https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace'
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024


def safe_members(archive):
    """Validate the entire archive before writing: no links, devices, traversal or duplicates."""
    members, seen, total = [], set(), 0
    for entry in archive.getmembers():
        path = PurePosixPath(entry.name)
        if path.is_absolute() or '..' in path.parts or '\\' in entry.name or ':' in entry.name:
            raise ValueError('unsafe archive path')
        if not entry.isdir() and not entry.isfile():
            raise ValueError('archive links and special files are not supported')
        name = path.as_posix()
        if name in seen:
            raise ValueError('duplicate archive entry')
        seen.add(name)
        total += entry.size
        if total > MAX_EXPANDED or len(seen) > 12000:
            raise ValueError('archive expansion limit exceeded')
        members.append(entry)
    return members


def extract(archive_path, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix='.extract-') as temp:
        root = Path(temp)
        with tarfile.open(archive_path, 'r:gz') as archive:
            for entry in safe_members(archive):
                target = root / entry.name
                if entry.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(entry) as source, target.open('xb') as output:
                        shutil.copyfileobj(source, output)
        manifests = list(root.glob('.codebuddy-plugin/plugin.json')) + list(root.glob('*/.codebuddy-plugin/plugin.json'))
        if len(manifests) != 1:
            raise ValueError('expected one expert package manifest')
        package_root = manifests[0].parent.parent
        if destination.exists():
            shutil.rmtree(destination)
        shutil.move(str(package_root), str(destination))


def download_one(item, output):
    plugin = item.get('plugin', '')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,150}', plugin):
        return {'id': item.get('id'), 'status': 'invalid-plugin-id'}
    url = f'{BASE}/bundles/{plugin}.tar.gz'
    archive = output / 'raw' / f'{plugin}.tar.gz'
    receipt = {'id': item.get('id'), 'plugin': plugin, 'url': url}
    try:
        if not archive.exists():
            for attempt in range(2):
                part = archive.with_suffix('.part')
                try:
                    with urllib.request.urlopen(url, timeout=40) as response, part.open('wb') as handle:
                        if int(response.headers.get('Content-Length', '0')) > MAX_ARCHIVE:
                            raise ValueError('archive size limit exceeded')
                        size = 0
                        while chunk := response.read(128 * 1024):
                            size += len(chunk)
                            if size > MAX_ARCHIVE:
                                raise ValueError('archive size limit exceeded')
                            handle.write(chunk)
                    part.replace(archive)
                    break
                except Exception:
                    part.unlink(missing_ok=True)
                    if attempt:
                        raise
                    time.sleep(1)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        destination = output / 'packages' / plugin
        marker = destination / '.studio-source-sha256'
        if not marker.exists() or marker.read_text() != digest:
            extract(archive, destination)
            marker.write_text(digest)
        manifest = json.loads((destination / '.codebuddy-plugin/plugin.json').read_text())
        return {**receipt, 'status': 'downloaded', 'sha256': digest, 'bytes': archive.stat().st_size,
                'version': manifest.get('version'), 'expertType': manifest.get('expertType', 'agent')}
    except Exception as error:
        # Errors only reference public downloads, never account files or credential state.
        return {**receipt, 'status': 'failed', 'reason': f'{type(error).__name__}: {error}'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--jobs', type=int, default=4)
    parser.add_argument('--limit', type=int)
    args = parser.parse_args()
    source = json.loads(args.manifest.read_text())
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / 'raw').mkdir(exist_ok=True)
    (output / 'manifest.json').write_text(json.dumps(source, ensure_ascii=False, indent=2))
    items = list({item.get('plugin', item['id']): item for item in source['experts']}.values())
    if args.limit:
        items = items[:args.limit]
    rows = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.jobs, 6))) as pool:
        futures = [pool.submit(download_one, item, output) for item in items]
        for future in as_completed(futures):
            rows.append(future.result())
            if len(rows) % 25 == 0:
                print(json.dumps({'processed': len(rows), 'total': len(items), 'downloaded': sum(row['status'] == 'downloaded' for row in rows)}), flush=True)
    report = {'source': BASE, 'manifestSha256': hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
              'catalogEntries': len(source['experts']), 'bundles': sorted(rows, key=lambda row: row['id'])}
    (output / 'downloads.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({'finished': len(rows), 'downloaded': sum(row['status'] == 'downloaded' for row in rows), 'failed': sum(row['status'] != 'downloaded' for row in rows)}))


if __name__ == '__main__':
    main()
