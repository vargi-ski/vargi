#!/usr/bin/env python3
"""Build the private function bundle using an explicit, secret-free allowlist."""
import argparse
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path, help='New .zip path; existing files are refused')
args = parser.parse_args()
root = Path(__file__).resolve().parent
with zipfile.ZipFile(args.output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
    for name in ('index.js', 'submit.mjs'):
        archive.write(root / name, arcname=name)
print('Function bundle created: 2 source files; no configuration or dependencies included.')
