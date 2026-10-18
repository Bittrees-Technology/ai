import importlib.util
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('source', Path(__file__).resolve().parents[1] / 'scripts/storage_cleanup_source.py')
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)

class CacheSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        (self.cache / 'one').write_text('reproducible cache')
    def tearDown(self):
        self.temp.cleanup()
    def snapshot(self):
        return source.snapshot(self.cache, time.time() + 7200)[0]
    def test_symlink_ancestor_and_descendant_never_followed(self):
        (self.root / 'link').symlink_to(self.cache, target_is_directory=True)
        with self.assertRaises(OSError):
            source.open_directory(self.root / 'link')
        (self.cache / 'outside').symlink_to(self.root)
        with self.assertRaises(ValueError):
            self.snapshot()
        self.assertTrue((self.cache / 'one').exists())
    def test_hardlink_and_recent_change_held(self):
        with self.assertRaisesRegex(ValueError, 'Recently'):
            source.snapshot(self.cache)
        os.link(self.cache / 'one', self.cache / 'two')
        with self.assertRaisesRegex(ValueError, 'hard link'):
            self.snapshot()
    def test_changed_or_inserted_entry_never_swept(self):
        old = self.snapshot()
        (self.cache / 'new-source').write_text('must retain')
        with self.assertRaises(ValueError):
            source.remove_snapshot(self.cache, old)
        self.assertTrue((self.cache / 'new-source').exists())
        self.assertTrue((self.cache / 'one').exists())
    def test_delete_only_inventoried_regular_files_keep_directories(self):
        (self.cache / 'nested').mkdir()
        (self.cache / 'nested' / 'two').write_text('cache')
        old = self.snapshot()
        source.remove_snapshot(self.cache, old)
        self.assertEqual(list((self.cache / 'nested').iterdir()), [])
        self.assertFalse((self.cache / 'one').exists())
        self.assertTrue(self.cache.is_dir())
    def test_open_files_and_package_process_hold(self):
        for processes, opened in [('node /usr/bin/npm install', ''), ('idle', 'n' + str(self.cache / 'one'))]:
            with patch.object(source, 'run', side_effect=[processes, opened]):
                with self.assertRaises(ValueError):
                    source.activity(self.cache, None)
    def test_compiler_requires_ignored_untracked_exact_root(self):
        root = Path.home() / 'project'
        cache = root / '.next/cache/webpack'
        with patch.object(source, 'run', side_effect=[str(root), '', '.next/cache/webpack/source.ts']):
            with self.assertRaisesRegex(ValueError, 'Tracked'):
                source.repository(cache, root)
        with patch.object(source, 'run', side_effect=[str(root), ValueError('not ignored')]):
            with self.assertRaisesRegex(ValueError, 'not ignored'):
                source.repository(cache, root)
        with self.assertRaises(ValueError):
            source.scope(root / 'node_modules', root)
    def test_command_output_bounded(self):
        with self.assertRaisesRegex(ValueError, 'bound'):
            source.run(['/bin/echo', 'too much'], limit=2)
    def test_snapshot_entry_bound(self):
        with patch.object(source, 'MAX_ENTRIES', 1):
            with self.assertRaisesRegex(ValueError, 'bound'):
                self.snapshot()

if __name__ == '__main__':
    unittest.main()
