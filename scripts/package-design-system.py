#!/usr/bin/env python3
"""Sync working web icon actions into the standalone design manual and archive."""
from pathlib import Path
import hashlib
import json
import re
import zipfile

repo = Path(__file__).resolve().parent.parent
kit = repo / 'token-horizon-design-system'
components = kit / 'components'
components.mkdir(exist_ok=True)
source = (repo / 'docs/icon-actions.js').read_text()
(components / 'icon-actions.js').write_text(source)
css = (repo / 'docs/horizon-system.css').read_text()
start = css.index('/* Shared icon action pattern.')
end = css.index('/* Landing page */', start)
(components / 'icon-actions.css').write_text(css[start:end])
for name in ['crew', 'invite', 'about', 'share', 'close']:
    match = re.search(r'    ' + name + r": '([^']+)'", source)
    if not match:
        raise ValueError('Missing shared icon: ' + name)
    (kit / 'assets/icons' / (name + '.svg')).write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" '
        'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" '
        'stroke-linejoin="round"><title>' + name.title() + '</title>' + match[1] + '</svg>\n')

entry = re.search(r'<a class="th-nav-signin"[^>]*><svg[^>]*>(.*?)</svg>', (repo / 'docs/index.html').read_text())
if not entry:
    raise ValueError('Missing navigation sign-in icon')
(kit / 'assets/icons/sign-in.svg').write_text(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" '
    'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" '
    'stroke-linejoin="round"><title>Sign in</title>' + entry[1] + '</svg>\n')

files = sorted(p for p in kit.rglob('*') if p.is_file() and not any(part.startswith('.') for part in p.relative_to(kit).parts))
manifest = json.loads((kit / 'manifest.json').read_text())
manifest.update(version='1.1.0', updatedAt='2026-10-02')
manifest['vectors']['icons'] = len(list((kit / 'assets/icons').glob('*.svg')))
manifest['webComponents'] = {'source': ['docs/icon-actions.js', 'docs/horizon-system.css'], 'sync': 'python3 scripts/package-design-system.py'}
manifest['files'] = [{'path': str(p.relative_to(kit)), 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in files if p.name != 'manifest.json']
(kit / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
output = repo / 'token-horizon-design-system.zip'
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for p in files:
        archive.write(p, p.relative_to(repo))
print(f'Synced shared actions and packaged {len(files)} design-system files into {output.name}.')
