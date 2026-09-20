#!/usr/bin/env python3
"""Create a private .env with random bootstrap credentials. Never overwrite it."""
import base64
import os
from pathlib import Path
import secrets

path = Path(__file__).resolve().parents[1] / '.env'
content = (
    'RELAY_ADMIN_TOKEN=' + secrets.token_urlsafe(48) + '\n'
    'RELAY_MASTER_KEY=' + base64.b64encode(secrets.token_bytes(32)).decode() + '\n'
    'RELAY_PUBLIC_URL=http://localhost:8080\n'
    'RELAY_BIND=127.0.0.1:8080\n'
    'DATABASE_URL=sqlite://data/relay.db\n'
    'RUST_LOG=webhook_relay=info\n'
)
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    raise SystemExit('.env already exists; it was not changed.')
with os.fdopen(fd, 'w') as file:
    file.write(content)
print('Created .env with mode 0600. Back up RELAY_MASTER_KEY separately from the database.')
