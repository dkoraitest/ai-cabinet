"""Образцы программы процесса из скилла add-process (programma.md): основа, словарь, шаблон Word.

Каждый образец собирается в программу так, как велит справка: основа, блок, пример main. Программа
запускается как программа процесса, её result.json проверяет node tools/processes.mjs list (та же схема,
что у карточки), а сверку со скиллом node tools/processes.mjs compare.

Запуск: python -m unittest discover -s tools/tests -p "test_*.py"
"""

import importlib.util
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
GUIDE = ROOT / ".claude" / "skills" / "add-process" / "programma.md"
CASE = ROOT / "input" / "case-azs" / "data"
NODE = shutil.which("node")

try:
    import openpyxl  # noqa: F401
    import docx  # noqa: F401
    HAVE_LIBS = True
except ImportError:
    HAVE_LIBS = False


def blocks():
    text = GUIDE.read_text(encoding="utf-8")
    found = re.findall(r"```python\n(.*?)```", text, re.S)
    named = {}
    for b in found:
        if b.startswith('"""<Название процесса>'):
            named["base"] = b
        elif b.startswith("# --- Словарь"):
            named["slovar"] = b
        elif b.startswith("# --- Шаблон Word"):
            named["word"] = b
        elif "slovar = load_slovar()" in b and b.startswith("def main():"):
            named["main_slovar"] = b
        elif "fill_docx(" in b and b.startswith("def main():"):
            named["main_word"] = b
    assert len(found) == 5 and len(named) == 5, f"в справке нужны 5 образцов, найдено {sorted(named)}"
    return named


def compose(*extra):
    """Основа без своего main, затем блоки и пример main перед запуском."""
    b = blocks()
    base = b["base"].replace("<имя>", "proba").replace("<Название процесса>", "Проба")
    if not extra:
        return base
    head, sep, tail = base.partition("\ndef main():")
    assert sep, "в основе нет def main()"
    run_part = tail[tail.index("\nif __name__"):]
    return head + "\n" + "\n\n".join(b[name] for name in extra) + "\n" + run_part


class Cabinet:
    def __init__(self, code):
        self.tmp = tempfile.TemporaryDirectory()
        self.cab = Path(self.tmp.name) / "Айгуль Н" / "ai-cabinet"
        shutil.copytree(TOOLS, self.cab / "tools", ignore=shutil.ignore_patterns("tests", "__pycache__"))
        self.proc = self.cab / "processes" / "proba"
        self.proc.mkdir(parents=True)
        (self.proc / "run.py").write_text(code, encoding="utf-8")
        (self.proc / "process.json").write_text(json.dumps(
            {"title": "Проба", "phrase": "запусти пробу", "kind": "script"}, ensure_ascii=False), encoding="utf-8")
        self.input = self.cab / "input" / "proba"
        self.input.mkdir(parents=True)
        self.out = self.cab / "output" / "proba"

    def close(self):
        self.tmp.cleanup()

    def run(self):
        return subprocess.run([sys.executable, str(self.proc / "run.py")], cwd=self.cab,
                              capture_output=True, encoding="utf-8")

    def result(self):
        return json.loads((self.out / "result.json").read_text(encoding="utf-8"))

    def module(self):
        """Программа как модуль: её функции для проверки по отдельности."""
        spec = importlib.util.spec_from_file_location(f"run_proba_{id(self)}", self.proc / "run.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def node(self, *args):
        r = subprocess.run([NODE, str(self.cab / "tools" / "processes.mjs"), *args], cwd=self.cab,
                           capture_output=True, encoding="utf-8")
        return r.returncode, r.stdout + r.stderr


def manual_rows(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True)
    try:
        return [list(r) for r in wb.active.iter_rows(values_only=True)]
    finally:
        wb.close()


@unittest.skipUnless(HAVE_LIBS, "нет openpyxl или python-docx")
class Base(unittest.TestCase):
    def run_base(self, rows, limit=None):
        code = compose()
        if limit is not None:
            code, n = re.subn(r"^LIMIT = .*$", f"LIMIT = {limit}", code, flags=re.M)
            self.assertEqual(n, 1, "в образце нет строки LIMIT = ...")
        c = Cabinet(code)
        self.addCleanup(c.close)
        lines = ["АЗС;Литры"] + [f"АЗС-{i:02d};{i * 10}" for i in range(1, rows + 1)]
        (c.input / "sales.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")
        proc = c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return c, c.result()

    def test_all_rows_no_warning(self):
        c, r = self.run_base(5)
        self.assertNotIn("Внимание", r["summary"])
        self.assertIn("sales.csv", r["summary"])
        self.assertIn("Разобрать вручную: 0", r["summary"])

    def test_truncated_rows_warned_in_summary(self):
        _, r = self.run_base(5, limit=3)
        self.assertIn("Внимание: в файле 5 строк, посчитаны первые 3.", r["summary"])

    def test_manual_file_written_even_empty(self):
        c, r = self.run_base(2)
        self.assertEqual(r["files"], ["output/proba/razobrat-vruchnuyu.xlsx"])
        rows = manual_rows(c.out / "razobrat-vruchnuyu.xlsx")
        self.assertEqual(rows[0], ["АЗС", "Литры", "Почему"])
        self.assertEqual(rows[1][0], "Всё разобрано программой.")
        self.assertIn("sverka", r)

    def test_no_input_clear_stop(self):
        c = Cabinet(compose())
        self.addCleanup(c.close)
        proc = c.run()
        self.assertEqual(proc.returncode, 2)
        self.assertIn("В папке input/proba нет файла", proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)


SLOVAR = {
    "качество топлива": ["качество топлива", "топливо", "аи 92", "дт", "дизель", "жанармай", "недолив"],
    "обслуживание и персонал": ["оператор", "кассир", "нахамил", "нагрубил", "очередь", "вежлив"],
    "оплата и касса": ["чек", "списали", "терминал", "оплата", "касса"],
    "минимаркет и кафе": ["кофе", "кафе", "выпечка", "хот-дог"],
    "программа лояльности": ["бонус", "карта лояльности", "акция"],
    "чистота и санузлы": ["туалет", "санузел", "санузл", "грязно", "дәретхана"],
    "оборудование": ["колонка", "колонок", "пистолет", "пылесос", "табло", "подкачка"],
    "благодарность": ["спасибо", "благодар", "рахмет"],
}


@unittest.skipUnless(HAVE_LIBS, "нет openpyxl или python-docx")
class Slovar(unittest.TestCase):
    def setUp(self):
        self.c = Cabinet(compose("slovar", "main_slovar"))
        self.addCleanup(self.c.close)
        (self.c.proc / "slovar.json").write_text(json.dumps(SLOVAR, ensure_ascii=False), encoding="utf-8")

    def test_word_rule(self):
        m = self.c.module()
        s = m.load_slovar()
        cls = lambda t: m.classify(t, s)[0]
        self.assertEqual(m.stem("бонусы"), "бонус")
        self.assertEqual(m.stem("касса"), "касс")
        self.assertEqual(m.stem("очередь"), "очеред")
        self.assertEqual(m.stem("мыло"), "мыл")
        self.assertEqual(m.stem("чек"), "чек")
        self.assertEqual(cls("Почему бонусов так мало?"), "программа лояльности")
        self.assertEqual(cls("Заправился ДТ, машина не заводится"), "качество топлива")
        self.assertEqual(cls("После ДТП стоял у вас на заправке"), m.MANUAL)  # «дт» только целым словом
        self.assertEqual(cls("АИ-92 явно хуже, чем у соседей"), "качество топлива")  # фраза «аи 92»
        self.assertEqual(cls("ЖАНАРМАЙ сапасы нашар"), "качество топлива")  # регистр, казахский
        self.assertEqual(cls("Дәретханада қағаз жоқ"), "чистота и санузлы")
        self.assertEqual(cls("Ещё раз про бонусы"), "программа лояльности")

    def test_manual_reasons(self):
        m = self.c.module()
        s = m.load_slovar()
        self.assertEqual(m.classify("", s), (m.MANUAL, "пустой текст"))
        self.assertEqual(m.classify("Можно ли оставить машину на ночь?", s), (m.MANUAL, "нет слов из словаря"))
        cat, why = m.classify("Кофе холодный, а оператор нагрубил", s)  # кафе 1, персонал 2
        self.assertEqual(cat, "обслуживание и персонал")
        cat, why = m.classify("Кофе холодный, а кассир молчал", s)  # по одному слову у двух категорий
        self.assertEqual(cat, m.MANUAL)
        self.assertIn("поровну", why)
        self.assertIn("минимаркет и кафе", why)

    def test_broken_slovar_clear_stop(self):
        (self.c.proc / "slovar.json").write_text('{"тема": ["слово",]}', encoding="utf-8")
        shutil.copy(CASE / "obrashcheniya.xlsx", self.c.input / "obrashcheniya.xlsx")
        proc = self.c.run()
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn("Словарь processes/proba/slovar.json испорчен (строка 1)", proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)
        (self.c.proc / "slovar.json").unlink()
        proc = self.c.run()
        self.assertEqual(proc.returncode, 2)
        self.assertIn("Нет словаря processes/proba/slovar.json", proc.stderr)

    def test_case_file_card_manual_list_and_check(self):
        shutil.copy(CASE / "obrashcheniya.xlsx", self.c.input / "obrashcheniya.xlsx")
        proc = self.c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        r = self.c.result()
        self.assertEqual(len(r["rows"]), 80)
        manual = [i for i, s in enumerate(r["row_status"]) if s == "info"]
        self.assertTrue(manual, "на файле кейса есть строки без слов из словаря")
        self.assertEqual(manual, list(range(len(manual))), "строки «разобрать вручную» идут первыми")
        self.assertTrue(all(r["row_note"][i] == "разобрать вручную" for i in manual))
        self.assertTrue(all(s is None for s in r["row_status"][len(manual):]))
        self.assertIn(f"Разобрать вручную: {len(manual)} (файл razobrat-vruchnuyu.xlsx)", r["summary"])
        self.assertIn("output/proba/razobrat-vruchnuyu.xlsx", r["files"])
        self.assertEqual(len(manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")), len(manual) + 1)
        rows = r["sverka"]["по строкам"]
        self.assertEqual(len(rows), 80)
        self.assertEqual(rows["38"], "повтор")  # повтор обращения 22 той же АЗС
        self.assertEqual(rows["79"], "повтор")
        self.assertEqual(r["sverka"]["итоги"], {"обращений": 80, "повторов": 2})
        self.assertEqual(sum(r["sverka"]["по категориям"].values()), 80 - 2 - len(manual))
        if not NODE:
            return
        code, out = self.c.node("list")
        self.assertEqual(code, 0, out)
        self.assertIn("Результат:", out)
        self.assertNotIn("Ошибка", out)
        etalon = {k: r["sverka"][k] for k in ("итоги", "по категориям")}
        etalon["по строкам"] = dict(rows)
        first = r["rows"][0][0]  # строка «разобрать вручную»: у скилла своя тема
        etalon["по строкам"][first] = "другое"
        etalon["по категориям"] = dict(etalon["по категориям"], **{"другое": 1})
        (self.c.out / "etalon-skilla.json").write_text(json.dumps(etalon, ensure_ascii=False), encoding="utf-8")
        code, out = self.c.node("compare", "proba")
        self.assertEqual(code, 0, out)
        self.assertIn("кроме", out)


@unittest.skipUnless(HAVE_LIBS, "нет openpyxl или python-docx")
class Word(unittest.TestCase):
    def setUp(self):
        self.c = Cabinet(compose("word", "main_word"))
        self.addCleanup(self.c.close)

    def texts(self, path):
        import docx
        d = docx.Document(path)
        m = self.c.module()
        return [p.text for p in m.paragraphs(d)], d

    def make_template(self, with_table=True):
        """Шаблон, где Word разбил поле на куски, поле в таблице и в колонтитуле, поле-таблица."""
        import docx
        d = docx.Document()
        p = d.add_paragraph()
        p.add_run("Кому: {{Наименование ")
        r = p.add_run("поставщика}}")
        r.bold = True
        d.add_paragraph("Сумма: {{Сумма}} тенге, дата {{дата}}.")
        if with_table:
            d.add_paragraph("{{Таблица}}")
        t = d.add_table(rows=1, cols=1)
        t.cell(0, 0).text = "Подпись: {{Фамилия И. О.}}"
        d.sections[0].header.is_linked_to_previous = False
        d.sections[0].header.paragraphs[0].text = "Исх. от {{дата}}"
        d.save(self.c.proc / "shablon.docx")

    def test_fill_fields_split_runs_tables_header(self):
        self.make_template()
        m = self.c.module()
        path, missing = m.fill_docx({"Наименование поставщика": "ТОО «Ромашка»", "дата": "21.09.2026",
                                     "Сумма": m.money(1250000), "Таблица": [["Документ", "Сумма"], ["№ 41", "6 195 000,00"]]},
                                    "pismo-01.docx")
        self.assertEqual(path, "output/proba/pismo-01.docx")
        self.assertEqual(missing, ["Фамилия И. О."])
        texts, d = self.texts(self.c.out / "pismo-01.docx")
        self.assertIn("Кому: ТОО «Ромашка»", texts)
        self.assertIn("Сумма: 1 250 000,00 тенге, дата 21.09.2026.", texts)
        self.assertIn("Подпись: [нет данных]", texts)
        self.assertIn("Исх. от 21.09.2026", texts)
        self.assertNotIn("{{Таблица}}", texts)
        self.assertEqual([c.text for c in d.tables[0].rows[1].cells], ["№ 41", "6 195 000,00"])
        self.assertFalse(any("{{" in t for t in texts))

    def test_template_from_person_file_brackets_become_fields(self):
        shutil.copy(CASE / "template_pismo_postavshchiku.docx", self.c.input / "template.docx")
        code = (self.c.proc / "run.py").read_text(encoding="utf-8").replace('SOURCE_TEMPLATE = ""', 'SOURCE_TEMPLATE = "template.docx"')
        (self.c.proc / "run.py").write_text(code, encoding="utf-8")
        m = self.c.module()
        m.ensure_template()
        texts, _ = self.texts(self.c.proc / "shablon.docx")
        joined = "\n".join(texts)
        self.assertIn("{{Наименование поставщика}}", joined)
        self.assertIn("Исх. № ____ от {{дата}}", joined)
        self.assertNotIn("[", joined)
        before = (self.c.proc / "shablon.docx").read_bytes()
        m.ensure_template()  # готовый шаблон не переделывается: человек мог поправить его в Word
        self.assertEqual((self.c.proc / "shablon.docx").read_bytes(), before)

    def test_template_from_skill_text(self):
        m = self.c.module()
        m.ensure_template()
        texts, _ = self.texts(self.c.proc / "shablon.docx")
        self.assertEqual(texts, m.SHABLON_TEXT)

    def test_example_main_one_document_per_row(self):
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["Поставщик", "Сумма"])
        ws.append(["ТОО «Ромашка»", 1250000])
        ws.append(["ТОО «Василёк»", None])
        wb.save(self.c.input / "rashozhdeniya.xlsx")
        self.make_template(with_table=False)
        proc = self.c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        r = self.c.result()
        self.assertEqual(r["row_status"], ["info", None])
        self.assertEqual(r["rows"][0][0], "ТОО «Василёк»")
        self.assertIn("Разобрать вручную: 1", r["summary"])
        self.assertEqual(r["sverka"]["документов"], 2)
        self.assertEqual(r["sverka"]["по строкам"], {"ТОО «Василёк»": "разобрать вручную", "ТОО «Ромашка»": "1 250 000,00"})
        self.assertTrue((self.c.out / "pismo-01.docx").is_file() and (self.c.out / "pismo-02.docx").is_file())
        texts, _ = self.texts(self.c.out / "pismo-02.docx")
        self.assertIn("Сумма: [нет данных] тенге, дата 21.09.2026.", texts)
        rows = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")
        self.assertEqual(rows[1][-1], "нет данных: Сумма")
        if NODE:
            code, out = self.c.node("list")
            self.assertEqual(code, 0, out)
            self.assertNotIn("Ошибка", out)


if __name__ == "__main__":
    unittest.main()
