#!/usr/bin/env python3
"""Reproducibly package the repository's distributable Codex connector."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

repo = Path(__file__).resolve().parent.parent
source = repo / 'plugins' / 'token-horizon'
output = repo / 'docs' / 'downloads' / 'token-horizon-plugin.zip'
output.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
    for path in sorted(source.rglob('*')):
        if not path.is_file() or path.name == '.DS_Store':
            continue
        info = ZipInfo('token-horizon/' + path.relative_to(source).as_posix(), (2026, 9, 27, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, path.read_bytes())
print(output)
