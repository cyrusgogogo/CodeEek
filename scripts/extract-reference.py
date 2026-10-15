#!/usr/bin/env python3
"""Read-only ASAR reference extractor; never modifies the DSH installation."""
import json
import pathlib
import struct
import sys

archive = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2]).resolve()
packages = set(sys.argv[3:])
with archive.open('rb') as stream:
    prefix = stream.read(16)
    _, header_size, _, string_size = struct.unpack('<4I', prefix)
    header = json.loads(stream.read(string_size))
    data_start = 8 + header_size

    def walk(node, path=''):
        for name, entry in node.get('files', {}).items():
            rel = f'{path}/{name}'.lstrip('/')
            if 'files' in entry:
                yield from walk(entry, rel)
            else:
                yield rel, entry

    entries = list(walk(header))
    if not packages:
        names = sorted({p.split('/')[3] for p, e in entries
                        if p.startswith('dsh/node_modules/@deepseek-ai/')})
        print('\n'.join(names))
    else:
        count = 0
        for rel, entry in entries:
            bits = rel.split('/')
            if len(bits) < 5 or bits[:3] != ['dsh', 'node_modules', '@deepseek-ai']:
                continue
            if bits[3] not in packages or entry.get('link'):
                continue
            if not rel.endswith(('.js', '.mjs', '.ts', '.json', '.md', '.yml', '.yaml', '.css')):
                continue
            dest = out.joinpath(*bits[3:])
            dest.parent.mkdir(parents=True, exist_ok=True)
            if entry.get('unpacked'):
                source = pathlib.Path(str(archive) + '.unpacked').joinpath(*bits)
                if not source.is_file():
                    continue
                data = source.read_bytes()
            else:
                stream.seek(data_start + int(entry['offset']))
                data = stream.read(entry['size'])
            dest.write_bytes(data)
            count += 1
        print(f'Extracted {count} reference files to {out}')
