"""Offline protocol and pinned-provenance tests; no quantum packages required."""

import json
import pathlib
import subprocess
import sys
import unittest
from unittest.mock import Mock

from quantumblur_adapter import COMMIT, _provenance

RUNNER = pathlib.Path(__file__).resolve().with_name("runner.py")


class BackendTests(unittest.TestCase):
    def invoke(self, value):
        process = subprocess.run(
            [sys.executable, "-I", "-B", str(RUNNER)], input=json.dumps(value),
            text=True, capture_output=True, timeout=10, check=True,
        )
        self.assertEqual(process.stderr, "")
        return json.loads(process.stdout)

    def test_probe_reports_exact_source_and_missing_dependencies(self):
        response = self.invoke({"operation": "probe"})
        self.assertTrue(response["ok"])
        self.assertEqual(response["backend"], "local:quantumblur:" + COMMIT)
        self.assertEqual(response["license"], "Apache-2.0")
        self.assertIn("dependencies", response)

    def test_input_is_structured_and_rejects_unexpected_operations(self):
        self.assertFalse(self.invoke({"operation": "probe", "path": "/etc/passwd"})["ok"])
        self.assertFalse(self.invoke({"operation": "unknown"})["ok"])

    def test_only_exact_official_git_commit_is_accepted(self):
        def dist(url, commit):
            return Mock(read_text=lambda _: json.dumps({
                "url": url, "vcs_info": {"vcs": "git", "commit_id": commit},
            }))
        self.assertTrue(_provenance(dist("https://github.com/qiskit-community/QuantumBlur.git", COMMIT)))
        self.assertFalse(_provenance(dist("https://github.com/other/QuantumBlur", COMMIT)))
        self.assertFalse(_provenance(dist("https://github.com/qiskit-community/QuantumBlur", "main")))


if __name__ == "__main__":
    unittest.main()
