import contextlib
import hashlib
import io
import json
import os
import pathlib
import runpy
import sqlite3
import sys
import tempfile
import unittest
import zipfile


SCRIPT = pathlib.Path(os.environ.get('KINDLESPOUSE_TEST_CALIBRE_IMPORT', pathlib.Path(__file__).resolve().parents[1] / 'native' / 'CalibreImport.py')).resolve()


@unittest.skipUnless(os.name == 'nt', 'Requires the Windows Calibre Python runtime')
class CalibreImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ks-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.book = self.root / 'generated.epub'
        with zipfile.ZipFile(self.book, 'w') as archive:
            archive.writestr('mimetype', 'application/epub+zip')
            archive.writestr('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
            archive.writestr('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">generated-test</dc:identifier><dc:title>路径长度测试</dc:title><dc:creator>KindleSpouse</dc:creator><dc:language>zh</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>')
            archive.writestr('chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Generated test content.</p></body></html>')
        self.sha256 = hashlib.sha256(self.book.read_bytes()).hexdigest()

    def import_book(self, library, expected_hash=None):
        output = io.StringIO()
        previous = sys.argv
        try:
            sys.argv = [str(SCRIPT), str(library), str(self.book), expected_hash or self.sha256]
            with contextlib.redirect_stdout(output):
                runpy.run_path(str(SCRIPT), run_name='__main__')
        finally:
            sys.argv = previous
        result = next(line.removeprefix('KINDLESPOUSE_RESULT ') for line in output.getvalue().splitlines() if line.startswith('KINDLESPOUSE_RESULT '))
        return json.loads(result)

    def test_long_library_preserves_content_and_reuses_book_identity(self):
        library = self.root / ('nested-profile-' * 8) / '原有资料' / 'calibre-library'
        self.assertGreater(len(str(library)), 150)
        first = self.import_book(library)
        self.assertEqual(self.import_book(library), first)
        with contextlib.closing(sqlite3.connect(library / 'metadata.db')) as database:
            self.assertEqual(database.execute('SELECT COUNT(*) FROM books').fetchone()[0], 1)
            self.assertEqual(database.execute('PRAGMA quick_check').fetchone()[0], 'ok')
        formats = list(library.rglob('*.epub'))
        self.assertEqual(len(formats), 1)
        self.assertEqual(hashlib.sha256(formats[0].read_bytes()).hexdigest(), self.sha256)
        self.assertEqual(hashlib.sha256(self.book.read_bytes()).hexdigest(), self.sha256)

    def test_short_library_import_is_unchanged(self):
        library = self.root / 'lib'
        self.assertLessEqual(len(str(library)), 75)
        self.assertGreater(self.import_book(library)['id'], 0)
        self.assertTrue((library / 'metadata.db').is_file())

    def test_changed_file_does_not_create_a_library(self):
        library = self.root / 'rejected'
        with self.assertRaisesRegex(RuntimeError, 'confirmed file has changed'):
            self.import_book(library, '0' * 64)
        self.assertFalse(library.exists())


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(CalibreImportTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(not result.wasSuccessful())
