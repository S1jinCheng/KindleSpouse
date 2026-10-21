import json
import os
import sys
from calibre.ebooks.metadata.kfx import Container, extract_metadata

tools, source, destination = sys.argv[1:4]
sys.path.insert(0, tools)
from kfxlib import YJ_Book

with open(source, 'rb') as stream:
    original = stream.read()
if not original.startswith(b'CONT'):
    raise ValueError('Unsupported or encrypted KFX container')
metadata = extract_metadata(Container(original).decode())
if metadata.get('cde_content_type') != ['PDOC']:
    raise ValueError('Only unencrypted personal documents are supported')
book = YJ_Book(source)
pdf = metadata.get('file_creator') == ['FLYP']
content = book.convert_to_pdf() if pdf else book.convert_to_epub()
if not content:
    raise ValueError('No readable document was produced')
extension = 'pdf' if pdf else 'epub'
os.makedirs(destination, exist_ok=True)
target = os.path.join(destination, 'readable.' + extension)
with open(target, 'wb') as stream:
    stream.write(content)
print('KINDLESPOUSE_READABLE ' + json.dumps({'format': extension}))
