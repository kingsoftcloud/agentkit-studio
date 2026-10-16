#!/usr/bin/env python3
"""Freeze an explicitly selected public marketplace cache for offline Skill review."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


def snapshot(source, output):
    source = source.resolve()
    if not source.is_dir() or source == Path.home() or source == Path.home() / '.workbuddy':
        raise ValueError('Select a marketplace content directory, not an account directory')
    output = output.resolve()
    if output == source or source in output.parents or output in source.parents:
        raise ValueError('Source and output must be disjoint')
    if output.exists() and any(output.iterdir()):
        raise FileExistsError('Use a new snapshot directory to avoid mixing versions')
    output.mkdir(parents=True, exist_ok=True)
    records, skipped = [], []
    def walk(directory):
        for path in sorted(directory.iterdir()):
            relative = path.relative_to(source)
            if path.is_symlink() or path.name in {'.git', 'node_modules', '.DS_Store', '.env'}:
                skipped.append(relative.as_posix())
                continue
            if path.is_dir():
                walk(path)
            elif path.is_file():
                data = path.read_bytes()
                destination = output / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, destination)
                records.append({'path': relative.as_posix(), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    walk(source)
    skills = [row for row in records if row['path'].endswith('/SKILL.md') or row['path'] == 'SKILL.md']
    report = {'sourceName': source.name, 'skills': skills, 'files': records, 'skipped': skipped, 'installed': False, 'published': False}
    (output / 'studio-snapshot.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return {'sourceName': source.name, 'skills': len(skills), 'files': len(records), 'bytes': sum(row['bytes'] for row in records), 'skipped': len(skipped)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(snapshot(args.source, args.output)))
