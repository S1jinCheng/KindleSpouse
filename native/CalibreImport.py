import hashlib
import json
import os
import sys

from calibre.ebooks.metadata.meta import get_metadata
from calibre.library import db

library, filename, expected_hash = sys.argv[1:4]
with open(filename, 'rb') as stream:
    actual_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
if actual_hash != expected_hash:
    raise RuntimeError('The confirmed file has changed.')
os.makedirs(library, exist_ok=True)
database = db(library)
try:
    api = database.new_api
    matches = api.search('identifiers:"=kindlespouse_sha256:' + expected_hash + '"')
    if matches:
        book_id = min(matches)
    else:
        extension = os.path.splitext(filename)[1].lstrip('.').lower()
        with open(filename, 'rb') as stream:
            metadata = get_metadata(stream, stream_type=extension)
        metadata.set_identifier('kindlespouse_sha256', expected_hash)
        ids, duplicates = api.add_books([(metadata, {extension.upper(): filename})], add_duplicates=True, run_hooks=False)
        if not ids:
            raise RuntimeError('Calibre did not import the book.')
        book_id = ids[0]
    print('KINDLESPOUSE_RESULT ' + json.dumps({'id': book_id}))
finally:
    database.close()
