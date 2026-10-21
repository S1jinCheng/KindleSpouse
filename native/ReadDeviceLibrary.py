import base64
import json
import os
import sys

from calibre.ebooks.metadata.meta import get_metadata
from calibre.ebooks.metadata.kfx import read_metadata_kfx

root = os.path.realpath(sys.argv[1])
with open(os.path.join(root, 'snapshot-manifest.json'), encoding='utf-8') as stream:
    manifest = json.load(stream)
extensions = sorted(json.loads(sys.argv[2]), key=len, reverse=True)
books = []
for entry in manifest['files']:
    relative = entry['relative']
    extension = next((value for value in extensions if relative.lower().endswith('.' + value)), '')
    parts = relative.replace('\\', '/').lower().split('/')
    if extension not in extensions or '.notebooks' in parts or any(part.endswith('.sdr') for part in parts) or parts[-1] == 'my clippings.txt':
        continue
    filename = os.path.realpath(os.path.join(root, *relative.split('/')))
    if not filename.startswith(root + os.sep):
        continue
    item = {'relative': relative, 'format': extension, 'bytes': entry['bytes'], 'sha256': entry['sha256'], 'title': os.path.basename(filename)[:-len(extension)-1], 'author': '作者信息未提供'}
    try:
        with open(filename, 'rb') as stream:
            metadata = read_metadata_kfx(stream) if extension == 'kfx' else get_metadata(stream, stream_type=extension)
        if metadata.title and metadata.title.lower() not in ('unknown', '未知'):
            item['title'] = metadata.title
        if metadata.authors:
            item['author'] = '、'.join(metadata.authors)
        if metadata.languages:
            item['language'] = metadata.languages[0]
        cover_format, cover_data = metadata.cover_data
        if cover_data and len(cover_data) < 4 * 1024 * 1024 and cover_format in ('jpeg', 'jpg', 'png'):
            item['cover'] = 'data:image/' + ('jpeg' if cover_format == 'jpg' else cover_format) + ';base64,' + base64.b64encode(cover_data).decode('ascii')
    except Exception:
        item['metadataLimited'] = True
    books.append(item)
print('KINDLESPOUSE_LIBRARY ' + json.dumps(books, ensure_ascii=False))
