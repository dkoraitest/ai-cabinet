#!/usr/bin/env python3
"""Быстро заглянуть в таблицу (Excel или выгрузка 1С) перед любым расчётом.

    python tools/read_table.py <файл> [--sheet N|имя] [--rows 10] [--json]

Что печатает: кодировку и разделитель (для CSV/TXT), листы с числом строк (для XLSX),
строку шапки, названия столбцов, число строк данных и первые строки.
Объединённая двухуровневая шапка разворачивается в названия «Родитель / Дочерний».
--sheet принимает номер листа (с 1) или его имя.

Только стандартная библиотека и openpyxl, без pandas. Большие файлы читаются потоком.
Объединённые ячейки в режиме read_only openpyxl не видны, поэтому диапазоны объединений
берутся прямо из XML листа внутри xlsx (потоковое чтение, без второй загрузки книги).
Код выхода 2 и русское сообщение: файл не найден, тип не поддерживается, старый .xls,
файл защищён паролем.
"""

import argparse
import codecs
import csv
import io
import json
import re
import sys
import zipfile
from datetime import date, datetime, time
from pathlib import Path
from xml.etree import ElementTree as ET

HEADER_SCAN_ROWS = 30
CSV_CANDIDATES = [";", ",", "\t", "|"]
CSV_EXT = {".csv", ".txt", ".tsv"}
XLSX_EXT = {".xlsx", ".xlsm"}
OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
DELIM_NAMES = {";": "точка с запятой (;)", ",": "запятая (,)", "\t": "табуляция", "|": "вертикальная черта (|)"}


class UserError(Exception):
    """Понятная человеку ошибка: печатается по-русски, код выхода 2."""


def cell_text(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "да" if v else "нет"
    if isinstance(v, float):
        return str(int(v)) if v == int(v) and abs(v) < 1e15 else repr(v)
    if isinstance(v, datetime):
        return v.date().isoformat() if v.time() == time(0, 0) else v.isoformat(sep=" ")
    if isinstance(v, (date, time)):
        return v.isoformat()
    return str(v).strip()


# ---------- общий разбор строк: шапка, счёт, первые строки ----------

def pick_header(buffer):
    """Индекс строки шапки: первая, где заполнено не меньше половины ячеек."""
    width = 0
    for row in buffer:
        filled = [i for i, c in enumerate(row) if c != ""]
        if filled:
            width = max(width, filled[-1] + 1)
    for i, row in enumerate(buffer):
        n = sum(1 for c in row if c != "")
        if n and n * 2 >= width and (n >= 2 or width == 1):
            return i
    for i, row in enumerate(buffer):
        if any(c != "" for c in row):
            return i
    return None


def build_columns(buffer, h, merges):
    """Названия столбцов и число строк шапки (1 или 2 при объединённых ячейках)."""
    top = buffer[h]
    r = h + 1  # номер строки шапки в файле, с 1
    two_level = h + 1 < len(buffer) and any(m[0] == r and (m[3] > m[1] or m[2] > r) for m in merges)
    if not two_level:
        width = max((i + 1 for i, c in enumerate(top) if c != ""), default=0)
        return [top[i] if top[i] else f"(без названия {i + 1})" for i in range(width)], 1
    sub = buffer[h + 1]
    parent = list(top) + [""] * max(0, len(sub) - len(top))
    # Родитель растягивается на весь диапазон объединённых ячеек.
    for r1, c1, r2, c2 in merges:
        if r1 == r and r2 <= r + 1:
            val = top[c1 - 1] if c1 - 1 < len(top) else ""
            for c in range(c1 - 1, c2):
                if c < len(parent):
                    parent[c] = val
    width = max(
        max((i + 1 for i, c in enumerate(parent) if c != ""), default=0),
        max((i + 1 for i, c in enumerate(sub) if c != ""), default=0),
    )
    cols = []
    for i in range(width):
        p = parent[i] if i < len(parent) else ""
        c = sub[i] if i < len(sub) else ""
        if p and c and p != c:
            cols.append(f"{p} / {c}")
        else:
            cols.append(p or c or f"(без названия {i + 1})")
    return cols, 2


def scan(row_iter, merges, n_rows):
    """Один проход по строкам (списки строк, пустая строка = пустой список/ячейки)."""
    buffer, h, cols, hrows = [], None, None, 1
    nonempty, data_rows, sample = 0, 0, []
    for idx, row in enumerate(row_iter):
        row = [cell_text(c) for c in row]
        is_empty = not any(row)
        if not is_empty:
            nonempty += 1
        if cols is None:
            buffer.append(row)
            if len(buffer) >= HEADER_SCAN_ROWS:
                h = pick_header(buffer)
                if h is not None:
                    cols, hrows = build_columns(buffer, h, merges)
                    for pending in buffer[h + hrows:]:
                        if any(pending):
                            data_rows += 1
                            if len(sample) < n_rows:
                                sample.append(pending)
                    buffer = []
            continue
        if not is_empty:
            data_rows += 1
            if len(sample) < n_rows:
                sample.append(row)
    if cols is None:  # файл короче окна поиска шапки
        h = pick_header(buffer)
        if h is not None:
            cols, hrows = build_columns(buffer, h, merges)
            for pending in buffer[h + hrows:]:
                if any(pending):
                    data_rows += 1
                    if len(sample) < n_rows:
                        sample.append(pending)
    width = len(cols) if cols else 0
    sample = [(r + [""] * width)[:width] for r in sample]
    return {
        "header_row": (h + 1) if h is not None else None,
        "header_rows": hrows,
        "columns": cols or [],
        "data_rows": data_rows,
        "total_rows": nonempty,
        "rows": sample,
    }


# ---------- CSV / TXT ----------

def detect_encoding(path):
    """utf-8-sig (есть BOM), utf-8 или cp1251. Проверка потоком, файл целиком не грузится."""
    with path.open("rb") as f:
        head = f.read(3)
        if head == codecs.BOM_UTF8:
            return "utf-8-sig"
        f.seek(0)
        dec = codecs.getincrementaldecoder("utf-8")()
        try:
            while True:
                chunk = f.read(1 << 20)
                dec.decode(chunk, final=not chunk)
                if not chunk:
                    break
        except UnicodeDecodeError:
            return "cp1251"
    return "utf-8"


def detect_delimiter(lines):
    lines = [ln for ln in lines if ln.strip()]
    if not lines:
        return ";"
    try:
        d = csv.Sniffer().sniff("\n".join(lines), delimiters="".join(CSV_CANDIDATES)).delimiter
        multi = sum(1 for ln in lines if d in ln)
        if d in CSV_CANDIDATES and multi * 2 >= len(lines):
            return d
    except csv.Error:
        pass
    # Запасной вариант: символ, который чаще всего встречается и в большинстве строк.
    def score(d):
        counts = [ln.count(d) for ln in lines]
        return (sum(1 for c in counts if c > 0), sum(counts))
    best = max(CSV_CANDIDATES, key=score)
    return best if score(best)[0] else ";"


def read_csv(path, n_rows):
    enc = detect_encoding(path)
    with path.open("r", encoding=enc, errors="replace", newline="") as f:
        sample_lines = []
        for _ in range(60):
            ln = f.readline()
            if not ln:
                break
            sample_lines.append(ln)
    delim = detect_delimiter(sample_lines)
    with path.open("r", encoding=enc, errors="replace", newline="") as f:
        csv.field_size_limit(1 << 24)
        res = scan(csv.reader(f, delimiter=delim), [], n_rows)
    res.update(type="csv", encoding=enc, delimiter=delim)
    return res


# ---------- XLSX ----------

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
MERGE_RE = re.compile(rb'<(?:\w+:)?mergeCell\s[^>]*?ref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"')


def col_num(letters):
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def sheet_merges(path, sheet_index):
    """Диапазоны объединённых ячеек листа: (строка1, столбец1, строка2, столбец2), с 1.

    Читает XML листа потоком; при любой неудаче возвращает пустой список.
    """
    try:
        with zipfile.ZipFile(path) as z:
            wb = ET.fromstring(z.read("xl/workbook.xml"))
            rel_id = list(wb.find("m:sheets", NS))[sheet_index].get(f"{{{NS['r']}}}id")
            rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
            target = next(r.get("Target") for r in rels if r.get("Id") == rel_id)
            inner = target.lstrip("/") if target.startswith("/") else "xl/" + target
            out, tail = set(), b""
            with z.open(inner) as f:
                while True:
                    chunk = f.read(1 << 20)
                    data = tail + chunk
                    for m in MERGE_RE.finditer(data):
                        c2 = m.group(3) or m.group(1)
                        r2 = m.group(4) or m.group(2)
                        out.add((int(m.group(2)), col_num(m.group(1).decode()),
                                 int(r2), col_num(c2.decode())))
                    if not chunk:
                        break
                    tail = data[-300:]  # хвост на случай разрыва тега между кусками; повторы уйдут в set
            return sorted(out)
    except Exception:
        return []


def open_book(path):
    import openpyxl
    try:
        return openpyxl.load_workbook(path, read_only=True, data_only=True)
    except zipfile.BadZipFile:
        raise UserError(f"Файл «{path.name}» не похож на xlsx: он повреждён или закрыт паролем.")


def iter_sheet_rows(ws):
    try:
        ws.reset_dimensions()
    except Exception:
        pass
    for row in ws.iter_rows(values_only=True):
        yield list(row)


def resolve_sheet(names, wanted):
    if wanted is None:
        return 0
    if wanted in names:
        return names.index(wanted)
    if wanted.isdigit() and 1 <= int(wanted) <= len(names):
        return int(wanted) - 1
    listing = "; ".join(f"{i + 1}. {n}" for i, n in enumerate(names))
    raise UserError(f"Лист «{wanted}» не найден. Есть листы: {listing}.")


def read_xlsx(path, sheet, n_rows):
    wb = open_book(path)
    try:
        names = list(wb.sheetnames)
        si = resolve_sheet(names, sheet)
        merges = sheet_merges(path, si)
        res = scan(iter_sheet_rows(wb[names[si]]), merges, n_rows)
        sheets = []
        for i, name in enumerate(names):
            if i == si:
                sheets.append({"index": i + 1, "name": name, "rows": res["total_rows"]})
            else:
                cnt = sum(1 for row in iter_sheet_rows(wb[name]) if any(c not in (None, "") for c in row))
                sheets.append({"index": i + 1, "name": name, "rows": cnt})
    finally:
        wb.close()
    res.update(type="xlsx", sheets=sheets, sheet={"index": si + 1, "name": names[si]},
               merged_ranges=len(merges))
    return res


# ---------- вход и вывод ----------

def check_file(path):
    if not path.exists() or not path.is_file():
        raise UserError(f"Файл не найден: {path}")
    ext = path.suffix.lower()
    if ext == ".xls":
        raise UserError("Старый формат .xls не читается. Откройте файл в Excel и сохраните как .xlsx, затем повторите.")
    if ext not in CSV_EXT | XLSX_EXT:
        raise UserError(f"Тип файла «{ext or 'без расширения'}» не поддерживается. Нужны .xlsx, .csv или .txt.")
    if ext in XLSX_EXT:
        with path.open("rb") as f:
            magic = f.read(8)
        if magic == OLE_MAGIC:
            raise UserError(f"Файл «{path.name}» защищён паролем (или это старый Excel). "
                            "Снимите пароль в Excel и сохраните как .xlsx.")
    return ext


def analyze(path, sheet=None, n_rows=10):
    ext = check_file(path)
    res = read_xlsx(path, sheet, n_rows) if ext in XLSX_EXT else read_csv(path, n_rows)
    res["file"] = str(path)
    return res


def format_human(r):
    out = [f"Файл: {r['file']}"]
    if r["type"] == "csv":
        out.append(f"Кодировка: {r['encoding']}")
        out.append(f"Разделитель: {DELIM_NAMES.get(r['delimiter'], r['delimiter'])}")
    else:
        out.append("Листы:")
        for s in r["sheets"]:
            mark = " <- выбран" if s["index"] == r["sheet"]["index"] else ""
            out.append(f"  {s['index']}. {s['name']}: строк {s['rows']}{mark}")
    if r["header_row"] is None:
        out.append("Данных в таблице нет.")
        return "\n".join(out)
    levels = " (двухуровневая, объединённые ячейки развёрнуты)" if r["header_rows"] == 2 else ""
    out.append(f"Строка шапки: {r['header_row']}{levels}")
    out.append(f"Столбцов: {len(r['columns'])}")
    out.append("Столбцы: " + " | ".join(r["columns"]))
    out.append(f"Строк данных: {r['data_rows']}")
    out.append(f"Первые строки ({len(r['rows'])}):")
    for row in r["rows"]:
        out.append("  " + " | ".join(row))
    return "\n".join(out)


def main(argv=None):
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="Заглянуть в таблицу Excel или выгрузку 1С.")
    ap.add_argument("file", help="путь к .xlsx, .csv или .txt")
    ap.add_argument("--sheet", help="номер листа (с 1) или имя; по умолчанию первый")
    ap.add_argument("--rows", type=int, default=10, help="сколько первых строк показать (10)")
    ap.add_argument("--json", action="store_true", help="вывод в JSON для скриптов")
    a = ap.parse_args(argv)
    try:
        r = analyze(Path(a.file), a.sheet, max(0, a.rows))
    except UserError as e:
        print(str(e), file=sys.stderr)
        if a.json:
            print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 2
    except Exception as e:  # битый файл и прочее: без трейсбека для человека
        msg = f"Не удалось прочитать файл: {type(e).__name__}: {e}"
        print(msg, file=sys.stderr)
        if a.json:
            print(json.dumps({"error": msg}, ensure_ascii=False))
        return 2
    print(json.dumps(r, ensure_ascii=False, indent=2) if a.json else format_human(r))
    return 0


if __name__ == "__main__":
    sys.exit(main())
