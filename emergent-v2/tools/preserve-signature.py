#!/usr/bin/env python3
"""Preserve the exact embedded signature outside Git; never upload or transform it."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('archive', type=Path)
parser.add_argument('private_directory', type=Path)
args = parser.parse_args()
out = args.private_directory.resolve()
checkout = Path(__file__).resolve().parents[2]
if out == checkout or checkout in out.parents:
    parser.error('Signature must be stored outside the Git checkout')
if subprocess.run(['git', '-C', str(out if out.exists() else out.parent), 'rev-parse', '--show-toplevel'], capture_output=True).returncode == 0:
    parser.error('Signature destination must not be inside any Git checkout')
with zipfile.ZipFile(args.archive) as archive:
    names = [n for n in archive.namelist() if n.endswith('/backup/original/Telecontinent_HR_Desk_ORIGINAL_UNCHANGED.html')]
    if len(names) != 1:
        parser.error('Expected exactly one original HTML source')
    text = archive.read(names[0]).decode('utf-8')
match = re.search(r'const LH_SIG="data:image/png;base64,([^"]+)"', text)
if not match:
    parser.error('No original PNG signature found')
data = base64.b64decode(match[1], validate=True)
if data[:8] != b'\x89PNG\r\n\x1a\n':
    parser.error('Original signature is not PNG')
out.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(out, 0o700)
asset = out / 'authorized-signature.png'
if asset.exists():
    if asset.is_symlink() or asset.read_bytes() != data:
        parser.error('Refusing to overwrite an existing different signature')
else:
    fd = os.open(asset, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
os.chmod(asset, 0o600)
width, height = struct.unpack('>II', data[16:24])
meta = out / 'signature-integrity.json'
if meta.is_symlink():
    parser.error('Refusing metadata symlink')
meta.write_text(json.dumps({'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
                            'width': width, 'height': height}, indent=2) + '\n')
os.chmod(meta, 0o600)
print('Exact original signature preserved securely outside Git; no image transformation or upload performed.')
