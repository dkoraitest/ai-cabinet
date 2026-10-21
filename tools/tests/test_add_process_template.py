"""Образец run.py из скилла add-process: запускается как программа процесса и не молчит об обрезке строк.

Запуск: python -m unittest discover -s tools/tests -p "test_*.py"
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
ROOT = TOOLS.parent
SKILL = ROOT / ".claude" / "skills" / "add-process" / "SKILL.md"


def template():
    text = SKILL.read_text(encoding="utf-8")
    blocks = re.findall(r"```python\n(.*?)```", text, re.S)
    assert len(blocks) == 1, "в скилле должен быть один образец run.py"
    return blocks[0]


class AddProcessTemplate(unittest.TestCase):
    def run_template(self, rows, limit=None):
        code = template().replace("<имя>", "proba").replace("<Название процесса>", "Проба")
        if limit is not None:
            code, n = re.subn(r"^LIMIT = .*$", f"LIMIT = {limit}", code, flags=re.M)
            self.assertEqual(n, 1, "в образце нет строки LIMIT = ...")
        with tempfile.TemporaryDirectory() as tmp:
            cab = Path(tmp) / "Айгуль Н" / "ai-cabinet"
            (cab / "tools").mkdir(parents=True)
            shutil.copy(TOOLS / "read_table.py", cab / "tools" / "read_table.py")
            (cab / "processes" / "proba").mkdir(parents=True)
            (cab / "processes" / "proba" / "run.py").write_text(code, encoding="utf-8")
            (cab / "input" / "proba").mkdir(parents=True)
            lines = ["АЗС;Литры"] + [f"АЗС-{i:02d};{i * 10}" for i in range(1, rows + 1)]
            (cab / "input" / "proba" / "sales.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(cab / "processes" / "proba" / "run.py")],
                cwd=cab,
                capture_output=True,
                encoding="utf-8",
            )
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            return json.loads((cab / "output" / "proba" / "result.json").read_text(encoding="utf-8"))

    def test_all_rows_no_warning(self):
        r = self.run_template(5)
        self.assertNotIn("Внимание", r["summary"])
        self.assertIn("sales.csv", r["summary"])

    def test_truncated_rows_warned_in_summary(self):
        r = self.run_template(5, limit=3)
        self.assertIn("Внимание: в файле 5 строк, посчитаны первые 3.", r["summary"])


if __name__ == "__main__":
    unittest.main()
