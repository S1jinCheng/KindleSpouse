import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest


class NotebookLabTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ks-notebook-lab-")
        self.root = Path(self.temporary.name)
        self.binary = self.root / "bin"
        self.binary.mkdir()
        self.output = self.root / "capture"
        self.commands = self.root / "commands"
        self.environment = dict(os.environ, PATH=str(self.binary) + ":" + os.environ["PATH"], KS_LAB_DIRECTORY=str(self.output), KS_LAB_TICKS="3", KS_TEST_COMMANDS=str(self.commands))
        self.script = Path(__file__).resolve().parents[1] / "native/notebook-lab/probe.sh"
        self.command("sleep", "exit 0\n")
        self.command("lipc-probe", "printf 'probe %s\\n' \"$*\" >> \"$KS_TEST_COMMANDS\"\nprintf 'start writable; activeView readable\\n'\n")
        self.command("lipc-get-prop", "printf 'get %s\\n' \"$*\" >> \"$KS_TEST_COMMANDS\"\ncase \"$2\" in activeView) printf 'KPP_NOTEBOOK\\n' ;; ActiveContext) printf 'app://native-editor?notebookId=fixture\\n' ;; *) exit 2 ;; esac\n")
        self.command("lipc-set-prop", "printf 'set %s\\n' \"$*\" >> \"$KS_TEST_COMMANDS\"\nexit \"${KS_TEST_LAUNCH_EXIT:-0}\"\n")

    def tearDown(self):
        self.temporary.cleanup()

    def command(self, name, text):
        target = self.binary / name
        target.write_text("#!/bin/sh\n" + text)
        target.chmod(0o700)

    def run_capture(self, mode="start"):
        return subprocess.run(["sh", str(self.script), "capture", mode], env=self.environment, capture_output=True, text=True, timeout=15)

    def run_directory(self):
        return next(item for item in self.output.iterdir() if item.is_dir())

    def test_launch_records_native_context_and_completes(self):
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        run = self.run_directory()
        self.assertEqual((run / "status.txt").read_text(), "capture_completed\n")
        self.assertEqual((run / "launch-result.txt").read_text(), "exit_code=0\n")
        self.assertEqual((run / "navigation.txt").read_text().count("TIME "), 1)
        self.assertIn("notebookId=fixture", (run / "navigation.txt").read_text())
        commands = self.commands.read_text().splitlines()
        self.assertEqual([line for line in commands if line.startswith("set ")], ["set com.lab126.appmgrd start app://com.lab126.KPPMainApp?view=KPP_NOTEBOOK"])
        self.assertFalse((self.output / "running").exists())

    def test_record_mode_never_launches_an_application(self):
        self.assertEqual(self.run_capture("record").returncode, 0)
        self.assertNotIn("set ", self.commands.read_text())
        self.assertFalse((self.run_directory() / "launch-result.txt").exists())

    def test_failed_launch_is_retained_without_retries(self):
        self.environment["KS_TEST_LAUNCH_EXIT"] = "7"
        self.assertEqual(self.run_capture().returncode, 0)
        self.assertEqual((self.run_directory() / "launch-result.txt").read_text(), "exit_code=7\n")
        self.assertEqual(self.commands.read_text().count("set com.lab126"), 1)

    def test_existing_capture_is_not_overwritten(self):
        (self.output / "running").mkdir(parents=True)
        self.assertEqual(self.run_capture().returncode, 3)
        self.assertFalse(self.commands.exists())

    def test_invalid_options_cannot_launch(self):
        self.environment["KS_LAB_TICKS"] = "181"
        self.assertEqual(self.run_capture().returncode, 2)
        self.environment["KS_LAB_TICKS"] = "1"
        self.environment["KS_LAB_DIRECTORY"] = str(self.root / "../outside")
        self.assertEqual(self.run_capture().returncode, 2)
        self.assertFalse(self.commands.exists())

    def test_handoff_waits_for_launcher_cleanup(self):
        self.command("sleep", "/bin/sleep 0.05\n")
        wrapper = subprocess.Popen(["sh", "-c", '/bin/sleep 0.2; printf "wrapper_clean\\n" >> "$KS_TEST_COMMANDS"'], env=self.environment)
        stamp = Path(f"/proc/{wrapper.pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]
        reaper = threading.Thread(target=wrapper.wait)
        reaper.start()
        result = subprocess.run(["sh", str(self.script), "handoff", str(wrapper.pid), stamp], env=self.environment, capture_output=True, text=True, timeout=15)
        reaper.join()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.commands.read_text().splitlines()[0], "wrapper_clean")
        self.assertIn("set com.lab126", self.commands.read_text())

    def test_handoff_refuses_pid_reuse_and_invalid_identity(self):
        for pid, stamp in [(str(os.getpid()), "0"), ("1", "1"), ("99999999", "1:2")]:
            result = subprocess.run(["sh", str(self.script), "handoff", pid, stamp], env=self.environment, capture_output=True, text=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.commands.exists())


if __name__ == "__main__":
    unittest.main()
