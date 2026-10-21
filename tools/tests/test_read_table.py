"""Тесты tools/read_table.py: только стандартная библиотека и openpyxl.

Запуск: python -m unittest discover -s tools/tests -p "test_*.py"
Фикстуры создаются во временной папке с кириллицей и пробелом в имени.
"""

import csv
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import openpyxl

TOOLS = Path(__file__).resolve().parent.parent
ROOT = TOOLS.parent
SCRIPT = TOOLS / "read_table.py"
CASE_DATA = ROOT / "input" / "case-azs" / "data"


def run(*args):
    proc = subprocess.run(
        [sys.executable, "-X", "utf8", str(SCRIPT), *map(str, args)],
        capture_output=True,
        encoding="utf-8",
    )
    return proc


def run_json(*args):
    proc = run(*args, "--json")
    if proc.returncode != 0:
        raise AssertionError(f"код {proc.returncode}: {proc.stdout}{proc.stderr}")
    return json.loads(proc.stdout)


class FixtureCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls._tmp.name) / "Папка Айгуль Н"
        cls.dir.mkdir()

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()


class CsvTests(FixtureCase):
    def test_cp1251_semicolon_with_title_row(self):
        p = self.dir / "выгрузка 1с.csv"
        text = (
            "Отчёт по продажам за период 01.09.2026 - 07.09.2026\r\n"
            "\r\n"
            "Дата;АЗС;Товар;Литры\r\n"
            "01.09.2026;АЗС-01;АИ-92;1 200,5\r\n"
            "02.09.2026;АЗС-02;ДТ;800\r\n"
        )
        p.write_bytes(text.encode("cp1251"))
        r = run_json(p)
        self.assertEqual(r["type"], "csv")
        self.assertEqual(r["encoding"], "cp1251")
        self.assertEqual(r["delimiter"], ";")
        self.assertEqual(r["columns"], ["Дата", "АЗС", "Товар", "Литры"])
        self.assertEqual(r["header_row"], 3)
        self.assertEqual(r["data_rows"], 2)
        self.assertEqual(r["rows"][0], ["01.09.2026", "АЗС-01", "АИ-92", "1 200,5"])

    def test_utf8_sig_comma(self):
        p = self.dir / "данные юникод.csv"
        p.write_bytes("﻿Код,Название,Сумма\n1,Мазут,10.5\n2,Бензин,20\n".encode("utf-8"))
        r = run_json(p)
        self.assertEqual(r["encoding"], "utf-8-sig")
        self.assertEqual(r["delimiter"], ",")
        self.assertEqual(r["columns"], ["Код", "Название", "Сумма"])
        self.assertEqual(r["data_rows"], 2)

    def test_plain_utf8_tab_and_rows_limit(self):
        p = self.dir / "tabs.txt"
        lines = ["a\tb\tc"] + [f"{i}\tx{i}\ty{i}" for i in range(30)]
        p.write_text("\n".join(lines), encoding="utf-8")
        r = run_json(p, "--rows", 3)
        self.assertEqual(r["encoding"], "utf-8")
        self.assertEqual(r["delimiter"], "\t")
        self.assertEqual(len(r["rows"]), 3)
        self.assertEqual(r["data_rows"], 30)

    def test_100k_rows_streamed(self):
        p = self.dir / "большой файл.csv"
        with p.open("w", encoding="cp1251", newline="") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(["Дата", "АЗС", "Литры"])
            for i in range(100_000):
                w.writerow([f"{i % 28 + 1:02d}.09.2026", f"АЗС-{i % 12 + 1:02d}", i])
        t = time.time()
        r = run_json(p)
        self.assertLess(time.time() - t, 20)
        self.assertEqual(r["data_rows"], 100_000)
        self.assertEqual(r["encoding"], "cp1251")

    def test_human_output_in_russian(self):
        p = self.dir / "человек.csv"
        p.write_bytes("Код;Имя\n1;Ёлка\n".encode("cp1251"))
        out = run(p)
        self.assertEqual(out.returncode, 0)
        self.assertIn("cp1251", out.stdout)
        self.assertIn("Разделитель", out.stdout)
        self.assertIn("Строка шапки", out.stdout)


class XlsxTests(FixtureCase):
    def test_two_level_merged_header(self):
        p = self.dir / "сводная шапка.xlsx"
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Свод"
        ws["A1"] = "Сводка по сети за сентябрь"
        ws["A2"] = "АЗС"
        ws.merge_cells("A2:A3")
        ws["B2"] = "Продажи"
        ws.merge_cells("B2:C2")
        ws["D2"] = "Остаток"
        ws.merge_cells("D2:E2")
        for col, v in zip("BCDE", ["Бензин", "Дизель", "Бензин", "Дизель"]):
            ws[f"{col}3"] = v
        ws.append(["АЗС-01", 10, 20, 30, 40])
        ws.append(["АЗС-02", 11, 21, 31, 41])
        wb.save(p)
        r = run_json(p)
        self.assertEqual(r["type"], "xlsx")
        self.assertEqual(
            r["columns"],
            ["АЗС", "Продажи / Бензин", "Продажи / Дизель", "Остаток / Бензин", "Остаток / Дизель"],
        )
        self.assertEqual(r["header_row"], 2)
        self.assertEqual(r["header_rows"], 2)
        self.assertEqual(r["data_rows"], 2)
        self.assertEqual(r["rows"][0], ["АЗС-01", "10", "20", "30", "40"])

    def test_three_sheets(self):
        p = self.dir / "три листа.xlsx"
        wb = openpyxl.Workbook()
        wb.active.title = "Астана"
        wb.active.append(["Договор", "Сумма"])
        for i in range(3):
            wb.active.append([f"Д-{i}", i])
        ws2 = wb.create_sheet("Караганда")
        ws2.append(["Договор", "Сумма"])
        for i in range(5):
            ws2.append([f"К-{i}", i])
        ws3 = wb.create_sheet("Справочник")
        ws3.append(["Код", "Название"])
        ws3.append([1, "Бензин"])
        wb.save(p)
        r = run_json(p)
        self.assertEqual([s["name"] for s in r["sheets"]], ["Астана", "Караганда", "Справочник"])
        self.assertEqual([s["rows"] for s in r["sheets"]], [4, 6, 2])
        self.assertEqual(r["sheet"]["name"], "Астана")
        r2 = run_json(p, "--sheet", 2)
        self.assertEqual(r2["sheet"]["name"], "Караганда")
        self.assertEqual(r2["data_rows"], 5)
        r3 = run_json(p, "--sheet", "Справочник")
        self.assertEqual(r3["columns"], ["Код", "Название"])
        self.assertEqual(r3["rows"], [["1", "Бензин"]])

    def test_vertical_merge_over_data_is_single_level_header(self):
        p = self.dir / "merge вниз.xlsx"
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["АЗС", "Показатель", "Знач"])
        ws.append([None, "a", 1])
        ws.append([None, "b", 2])
        ws.append([None, "c", 3])
        ws.append(["АЗС-02", "d", 4])
        ws.merge_cells("A1:A4")
        wb.save(p)
        r = run_json(p, "--rows", 20)
        self.assertEqual(r["columns"], ["АЗС", "Показатель", "Знач"])
        self.assertEqual(r["header_rows"], 1)
        self.assertEqual(r["data_rows"], 4)
        self.assertEqual(r["rows"][0], ["АЗС", "a", "1"])
        self.assertEqual(r["rows"][2], ["АЗС", "c", "3"])
        self.assertEqual(r["rows"][3], ["АЗС-02", "d", "4"])

    def test_three_level_header(self):
        p = self.dir / "три уровня.xlsx"
        wb = openpyxl.Workbook()
        ws = wb.active
        ws["A1"] = "Группа"
        ws.merge_cells("A1:C1")
        ws["A2"] = "Подгр1"
        ws.merge_cells("A2:B2")
        ws["C2"] = "Подгр2"
        for col, v in zip("ABC", ["x", "y", "z"]):
            ws[f"{col}3"] = v
        ws.append([1, 2, 3])
        ws.append([4, 5, 6])
        wb.save(p)
        r = run_json(p)
        self.assertEqual(r["columns"], ["Группа / Подгр1 / x", "Группа / Подгр1 / y", "Группа / Подгр2 / z"])
        self.assertEqual(r["header_rows"], 3)
        self.assertEqual(r["header_row"], 1)
        self.assertEqual(r["data_rows"], 2)
        self.assertEqual(r["rows"], [["1", "2", "3"], ["4", "5", "6"]])

    def test_unknown_sheet(self):
        p = self.dir / "лист для ошибки.xlsx"
        wb = openpyxl.Workbook()
        wb.active.title = "Астана"
        wb.active.append(["a", "b"])
        wb.save(p)
        out = run(p, "--sheet", "Нет такого")
        self.assertEqual(out.returncode, 2)
        self.assertIn("Астана", out.stderr)


    def test_sheet_as_number_from_program(self):
        # Программа процесса передаёт номер листа числом: read_table.analyze(путь, 2, ...).
        sys.path.insert(0, str(TOOLS))
        try:
            import read_table
        finally:
            sys.path.remove(str(TOOLS))
        p = self.dir / "листы числом.xlsx"
        wb = openpyxl.Workbook()
        wb.active.title = "Астана"
        wb.active.append(["Договор", "Сумма"])
        wb.active.append(["А-1", 1])
        ws2 = wb.create_sheet("Караганда")
        ws2.append(["Договор", "Сумма"])
        ws2.append(["К-1", 2])
        ws2.append(["К-2", 3])
        wb.save(p)
        r = read_table.analyze(p, 2, 10)
        self.assertEqual(r["sheet"]["name"], "Караганда")
        self.assertEqual(r["data_rows"], 2)
        self.assertEqual(read_table.analyze(p, 1.0, 10)["sheet"]["name"], "Астана")
        self.assertEqual(read_table.analyze(p, " 2 ", 10)["sheet"]["name"], "Караганда")
        for bad in (3, 0, -1, 1.5, True, [1]):
            with self.assertRaises(read_table.UserError) as ctx:
                read_table.analyze(p, bad, 10)
            msg = str(ctx.exception)
            self.assertIn("Астана", msg, bad)
            self.assertRegex(msg, "[А-Яа-я]")
        with self.assertRaises(read_table.UserError) as ctx:
            read_table.analyze(p, 3, 10)
        self.assertIn("номера с 1", str(ctx.exception))


class ErrorTests(FixtureCase):
    def test_missing_file(self):
        out = run(self.dir / "нет.csv")
        self.assertEqual(out.returncode, 2)
        self.assertIn("не найден", out.stderr)

    def test_old_xls(self):
        p = self.dir / "старый.xls"
        p.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 64)
        out = run(p)
        self.assertEqual(out.returncode, 2)
        self.assertIn("сохраните как .xlsx", out.stderr)

    def test_password_protected_xlsx(self):
        p = self.dir / "закрыт.xlsx"
        p.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 64)
        out = run(p)
        self.assertEqual(out.returncode, 2)
        self.assertIn("пароль", out.stderr)

    def test_unsupported_type(self):
        p = self.dir / "doc.pdf"
        p.write_bytes(b"%PDF-1.4")
        out = run(p)
        self.assertEqual(out.returncode, 2)
        self.assertIn("не поддерживается", out.stderr)


class CaseFilesSmoke(unittest.TestCase):
    def test_every_packed_case_table_reads(self):
        files = sorted(
            f for f in (ROOT / "input" / "case-azs").rglob("*") if f.suffix.lower() in (".csv", ".xlsx")
        )
        self.assertGreater(len(files), 10, "кейс не упакован: запустите pack_case.sh")
        for f in files:
            with self.subTest(file=str(f.relative_to(ROOT))):
                r = run_json(f)
                self.assertTrue(r["columns"], "шапка не найдена")
                self.assertGreater(r["data_rows"], 0)

    def test_registry_all_sheets(self):
        f = CASE_DATA / "reestr_dogovorov.xlsx"
        r = run_json(f)
        self.assertGreaterEqual(len(r["sheets"]), 3)
        for i in range(1, len(r["sheets"]) + 1):
            run_json(f, "--sheet", i)


if __name__ == "__main__":
    unittest.main()
