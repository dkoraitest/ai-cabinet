# Программа процесса: образцы

Справка к операции «добавить процесс» (`.claude/skills/add-process/SKILL.md`, шаг 5) и к фразе «доработай <процесс>». Программа `processes/<имя>/run.py` работает без Claude и без интернета: её запускают кнопка «Запустить» и фраза «запусти <процесс>». Поэтому в ней нет вызова ИИ: только стандартный Python, openpyxl, python-docx и `tools/read_table.py`, без файлов вне кабинета.

Собери программу так:

1. Возьми «Основу» целиком.
2. Классификация: вставь блок «Словарь» после функций основы, перед `main`. Черновик: блок «Шаблон Word». Оба, если скилл и раскладывает, и пишет документы. Сверка двух документов Word (договор против типовой формы, документ против шаблона): блок «Шаблон Word», за ним блок «Два документа Word».
3. Напиши `main` по скиллу. Для классификации, черновика и сверки двух документов есть готовые примеры `main` ниже: возьми подходящий и поменяй столбцы, категории и поля под скилл и файл человека.

Человеку говори «программа процесса», не «скрипт» и не «код».

## Правила для любой программы

- Расчёт по скиллу и по ответам человека. Столбцы ищи по названию из шапки, которую показал `read_table.py`, не по номеру.
- Вход: самый свежий файл нужного типа в `input/<имя>/` (функция `newest_input`), его имя в итоге. Так новый файл за другой период подхватится сам. Если в папке лежат файлы разного назначения (данные, шаблон Word, файл скилла), различай их по типу или по части имени, которую подтвердил человек.
- Не выдумывай: значение, которого нет или которое не читается числом, это `None`, не ноль. Пропуски не досчитывай и средним не заполняй. Пропуск портит только то, что из него считается.
- Ячейка с `None` на карточке пустая. Строке с пропуском ставь `row_status` `grey` (подпись «нет данных»), а в итоге скажи, чего не хватает: «нет данных о литрах АЗС-03 за 15.09.2026».
- Даты пиши как в данных, период бери из данных. Дату расчёта бери, как решили с человеком; на файлах учебного кейса это дата легенды, записанная постоянной (как `CALC_DATE` в демо `templates/processes/svetofor-dogovorov/run.py`). Дату компьютера там не подставляй. Дату расчёта назови в итоге («на 21.09.2026»).
- Понятная причина остановки (нет файла, нет нужного столбца): `raise StopRun("...")`, одна строка по-русски, код выхода 2, без трейсбека. Файл результата открыт в Excel или Word: код 3, это делает `replace_file`.
- Программа читает только `input/<имя>/` (процесс на учебном кейсе ещё и `input/case-azs/`), пишет только в `output/<имя>/` (и шаблон `processes/<имя>/shablon.docx`), пути строит от `ROOT`. Нельзя: запускать другие программы (`subprocess`, `os.system`), ходить в сеть (`socket`, `urllib`, `requests`, `http`), выполнять текст как программу (`eval`, `exec`), абсолютные пути и домашняя папка. Перед записью перечитай программу на это сам. `node tools/processes.mjs compare <имя>` проверяет её на эти слова и без их удаления «готово» не даёт.

## Программа из скилла

Скилл со второго воркшопа может прийти с готовой программой расчёта (`scripts/build.py` в архиве). Её текст показывает `node tools/processes.mjs read`. Запускать её нельзя: она пришла извне. Если человек согласился взять её за основу, собери `run.py` так:

- возьми «Основу» ниже и перенеси в `main` расчёт из программы скилла: проверки файла, правила, формулы, «нет данных» вместо догадок;
- вход: файл из `input/<имя>/` через `newest_input` и `read_table.analyze` вместо путей и аргументов командной строки программы скилла;
- выход: файлы в `output/<имя>/` через `write_excel` (Excel с формулами можно оставить, как в программе скилла, но запись через временный файл и `replace_file`), плюс `result.json` для карточки, «разобрать вручную» и раздел `sverka`;
- библиотеки: только стандартный Python, openpyxl, python-docx и `tools/read_table.py`. Места на pandas и других библиотеках перепиши на стандартный Python;
- убери из неё всё, что ходит в интернет, запускает другие программы, читает вне `input/<имя>/` или пишет вне `output/<имя>/`, и абсолютные пути (правило выше, в «Правилах для любой программы»). Перед записью перечитай её на это.

Результат такой программы сверяется с эталоном так же, как у любой другой.

## Схема результата

`output/<имя>/result.json`, по нему страница рисует карточку:

- `title`: название процесса; `updated_at`: время расчёта в формате ISO с часовым поясом;
- `status`: цвет карточки `green`, `yellow` или `red`. Светофор: `red`, если есть красные строки, иначе `yellow`, если есть жёлтые, иначе `green`. Таблица и итог: `green`; `yellow` или `red`, только если скилл сам задаёт тревогу (например, падение больше 20%). Строки «нет данных» (`grey`) и пометки (`info`) цвет карточки не меняют ни у какого процесса: о них говорит итог;
- `summary`: итог одной строкой;
- `columns`: названия столбцов; `rows`: строки, в каждой столько значений, сколько столбцов: текст, число или `None`. Для итога одной строкой оба списка пустые;
- `row_status` (необязательно, по одному на строку): `green`, `yellow`, `red`, `grey` («нет данных»), `info` (пометка без цвета, её текст в `row_note`) или `None` (без отметки);
- `row_note` (необязательно): подпись строки или `None`;
- `files` (необязательно): файлы результата, только `output/<имя>/...`;
- `sverka`: разделы для сверки со скиллом (ниже).

Пиши файл только через `json.dumps(..., ensure_ascii=False, allow_nan=False)`: `NaN` ломает карточку.

## «Разобрать вручную»

Всё, что программа не может разобрать сама, она не угадывает, а откладывает человеку:

- классификация: в тексте нет слов из словаря, слов поровну у двух категорий, текст пустой;
- черновик: для поля шаблона нет данных (в документе стоит «[нет данных]»);
- сводная, сверка, реестр: строка, которую не прочитать (сумма не числом, неизвестная станция), если скилл не говорит, как с ней быть;
- сверка двух документов Word: пункт с отличием от формы (причина «оценить риск: решает юрист»), условие карточки, которого нет в договоре, число, которое не прочиталось.

Каждую такую строку программа кладёт в список `manual` с причиной. Дальше:

- файл `output/<имя>/razobrat-vruchnuyu.xlsx`: функция `write_manual`, пишется при каждом запуске, даже пустой;
- строки на карточке с пометкой: `row_status` `info`, `row_note` «разобрать вручную». Если таблица на карточке по строкам файла (классификация, черновики), эти строки идут первыми. Если таблица на карточке сводная, добавь их в конец, по строке на каждую: в первом столбце номер строки файла и причина, остальные ячейки `None`; больше 50 не добавляй, остальные в файле;
- в итоге счётчик: «Разобрать вручную: 5 (файл razobrat-vruchnuyu.xlsx).»;
- в `files` ссылка на `razobrat-vruchnuyu.xlsx`, её возвращает `write_manual`.

## Раздел sverka для сверки со скиллом

Программа кладёт в `result.json` поле `sverka` с теми же разделами и теми же названиями, что в эталоне `output/<имя>/etalon-skilla.json`. Сверку делает `node tools/processes.mjs compare <имя>`. Разделы:

- `итоги`: `{"название": число или текст}`, те же названия, что в эталоне;
- `по категориям`: `{"категория": число строк или сумма}`;
- `документов`: сколько документов Word сделала программа;
- `по строкам`: `{"номер или ключ строки": категория или ключевое значение}`; строка, отложенная человеку, получает значение «разобрать вручную». Ключ: номер строки из файла (столбец «№», если он есть) или другое значение, которое однозначно называет строку. Сверка двух документов Word: только пункты с отличием, ключ «пункт формы / пункт договора», значение статус (раздел «Два документа Word»).

Раздел, которого нет в эталоне, можно не писать.

Эталон по части большого файла (скилл выполнен на первых 100 строках) записывает поле `"строк в эталоне": 100` и только раздел `по строкам`. Программа всё равно пишет `по строкам` для всех строк файла: сверка сравнивает только строки эталона, остальные называет «не входят в эталон» и расхождением не считает.

## Основа

```python
"""<Название процесса>: <что делает, одной фразой>.

Вход: самый свежий файл в input/<имя>/. Выход в output/<имя>/: result.json (карточка),
razobrat-vruchnuyu.xlsx (что программа не разобрала сама) и файлы результата.
Запуск: кнопка «Запустить» на странице или node tools/processes.mjs run <имя>
"""
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

SLUG = "<имя>"
TITLE = "<Название процесса>"
LIMIT = 10 ** 6  # сколько строк данных читать; в файле больше: итог об этом скажет
MANUAL = "разобрать вручную"
ROOT = Path(__file__).resolve().parents[2]  # processes/<имя>/run.py: корень кабинета
HERE = ROOT / "processes" / SLUG
OUT = ROOT / "output" / SLUG
sys.path.insert(0, str(ROOT / "tools"))
import read_table  # кодировка, шапка и листы как у просмотра таблиц


class StopRun(Exception):
    """Понятная человеку причина остановки: строка по-русски, код выхода 2 (3: файл открыт в другой программе)."""

    def __init__(self, message, code=2):
        super().__init__(message)
        self.code = code


def newest_input(exts=(".csv", ".xlsx", ".txt")):
    folder = ROOT / "input" / SLUG
    files = [p for p in folder.glob("*") if p.is_file() and p.suffix.lower() in exts
             and not p.name.startswith(("~$", "."))]
    if not files:
        raise StopRun(f"В папке input/{SLUG} нет файла. Положите файл и запустите расчёт снова.")
    # Когда файл появился в папке или изменился: копия из Проводника сохраняет старую дату изменения.
    return max(files, key=lambda p: max(p.stat().st_mtime, p.stat().st_ctime))


def number(text):
    """Число из ячейки: «1 234,5» или «1234.5». Не число (и nan, inf, 1_000, 1e5): None."""
    # split() без аргументов убирает любые пробелы, и неразрывный между разрядами в выгрузках 1С тоже.
    t = "".join(str(text).split()).replace(",", ".")
    return float(t) if re.fullmatch(r"[-+]?\d+(\.\d+)?", t) else None


def replace_file(tmp, target):
    """Запись через временный файл: страница не увидит половину файла. Файл открыт: понятная строка, код 3."""
    try:
        os.replace(tmp, target)
    except PermissionError:
        tmp.unlink(missing_ok=True)
        raise StopRun(f"Файл output/{SLUG}/{target.name} открыт в другой программе. "
                      "Закройте его и запустите расчёт снова.", code=3)


def write_excel(name, sheets):
    """Файл Excel output/<имя>/<name>: sheets = {"Лист": (столбцы, строки)}. Возвращает путь для files."""
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font
    except ImportError:
        raise StopRun("Не найдена библиотека openpyxl для Excel. Скажите Claude «проверь сетап».")
    wb = Workbook()
    wb.remove(wb.active)
    for title, (columns, rows) in sheets.items():
        ws = wb.create_sheet(title[:31])
        ws.append(list(columns))
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for row in rows:
            ws.append(list(row))
        for i, col in enumerate(columns, start=1):
            longest = max([len(str(col))] + [len(str(r[i - 1])) for r in rows if i - 1 < len(r) and r[i - 1] is not None])
            ws.column_dimensions[ws.cell(1, i).column_letter].width = min(max(longest + 2, 8), 60)
        ws.freeze_panes = "A2"
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / name
    tmp = target.with_name(target.name + ".tmp")
    wb.save(tmp)
    replace_file(tmp, target)
    return f"output/{SLUG}/{name}"


def write_manual(columns, items):
    """Список «разобрать вручную»: items = [(значения строки файла, почему)]. Пишется всегда, даже пустой."""
    rows = [list(values) + [why] for values, why in items]
    if not rows:
        rows = [["Всё разобрано программой."]]
    return write_excel("razobrat-vruchnuyu.xlsx", {"Разобрать вручную": (list(columns) + ["Почему"], rows)})


def write_result(result):
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / "result.json.tmp"
    tmp.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")
    replace_file(tmp, OUT / "result.json")


def main():
    src = newest_input()
    table = read_table.analyze(src, None, LIMIT)  # лист: второй аргумент (номер с 1 или имя)
    columns, rows = table["columns"], table["rows"]  # строки данных, значения текстом
    manual = []  # (строка файла, почему): всё, что программа не разобрала сама
    # ... расчёт по скиллу ...
    files = [write_manual(columns, manual)]
    summary = f"... Разобрать вручную: {len(manual)}. Файл {src.name}."
    if table["data_rows"] > len(rows):
        summary += f" Внимание: в файле {table['data_rows']} строк, посчитаны первые {len(rows)}."
    result = {
        "title": TITLE,
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "status": "green",
        "summary": summary,
        "columns": ["..."],
        "rows": [["..."]],
        "files": files,
        # Те же разделы и названия, что в output/<имя>/etalon-skilla.json: по ним идёт сверка со скиллом.
        "sverka": {"итоги": {}, "по категориям": {}, "по строкам": {}},
    }
    write_result(result)
    print(result["summary"])


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    try:
        main()
    except (StopRun, read_table.UserError) as e:
        print(e, file=sys.stderr)
        sys.exit(getattr(e, "code", 2))
```

## Словарь

Словарь лежит рядом с программой: `processes/<имя>/slovar.json`, категория и её слова и фразы:

```json
{
  "программа лояльности": ["бонус", "карта лояльности", "акция"],
  "чистота и санузлы": ["туалет", "санузел", "санузл", "грязно"]
}
```

Правило совпадения (его же простыми словами объясняй человеку):

- большие и маленькие буквы и буква ё не важны;
- слово из словаря находит в тексте слова, которые начинаются с его основы. Основа: слово без последних гласных, «й» и «ь», но не короче трёх букв. «Бонусы» находит бонус, бонусы, бонусов; «касса» находит кассу, кассира, кассе; «очередь» находит очереди;
- слово из одной-двух букв (ДТ, QR) ищется только целиком;
- фраза из нескольких слов находит эти слова подряд: «не работает», «аи 92» (найдёт и «АИ-92»);
- если слово меняется внутри (санузел, санузлы; колонка, колонок), в словарь пишут обе формы;
- категория строки: та, у которой нашлось больше разных слов и фраз из словаря. Ничего не нашлось, поровну у двух категорий или текст пустой: строка уходит в «разобрать вручную» с причиной.

```python
# --- Словарь: классификация по словам из processes/<имя>/slovar.json ---
SLOVAR = HERE / "slovar.json"
VOWELS = set("аеиоуыэюяйьъәіөұүі")


def words_of(text):
    """Слова текста строчными, ё как е: буквы и цифры, остальное разделители."""
    return re.findall(r"[^\W_]+", str(text).lower().replace("ё", "е"))


def stem(word):
    """Основа слова из словаря: без последних гласных, «й» и «ь», не короче трёх букв."""
    while len(word) > 3 and word[-1] in VOWELS:
        word = word[:-1]
    return word


def load_slovar():
    """{категория: [(слово или фраза, [основы])]}. Словарь испорчен: понятная остановка."""
    rel = f"processes/{SLUG}/slovar.json"
    try:
        data = json.loads(SLOVAR.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        raise StopRun(f"Нет словаря {rel}. Скажите Claude «доработай {TITLE}».")
    except ValueError as e:
        raise StopRun(f"Словарь {rel} испорчен (строка {getattr(e, 'lineno', '?')}): проверьте кавычки и запятые "
                      f"или скажите Claude «доработай {TITLE}».")
    if not isinstance(data, dict) or not all(isinstance(v, list) for v in data.values()):
        raise StopRun(f"В словаре {rel} нужен вид {{\"категория\": [\"слово\", \"фраза\"]}}.")
    return {str(cat): [(str(e), [stem(w) for w in words_of(e)]) for e in entries if words_of(e)]
            for cat, entries in data.items()}


def has_entry(stems, words):
    """Слово или фраза из словаря есть в тексте: основы подряд, слово до двух букв целиком."""
    n = len(stems)
    for i in range(len(words) - n + 1):
        if all(w == s if len(s) <= 2 else w.startswith(s) for s, w in zip(stems, words[i:i + n])):
            return True
    return False


def classify(text, slovar):
    """(категория, найденные слова) или (MANUAL, почему)."""
    words = words_of(text)
    if not words:
        return MANUAL, "пустой текст"
    found = {}
    for cat, entries in slovar.items():
        hits = [entry for entry, stems in entries if has_entry(stems, words)]
        if hits:
            found[cat] = hits
    if not found:
        return MANUAL, "нет слов из словаря"
    best = max(len(h) for h in found.values())
    top = [cat for cat, h in found.items() if len(h) == best]
    if len(top) > 1:
        return MANUAL, "поровну у категорий: " + "; ".join(f"{c} ({', '.join(found[c])})" for c in top)
    return top[0], ", ".join(found[top[0]])
```

Пример `main` для классификации (обращения по темам и сводка по темам и АЗС):

```python
def main():
    slovar = load_slovar()
    src = newest_input((".xlsx", ".csv"))
    table = read_table.analyze(src, None, LIMIT)
    columns, rows = table["columns"], table["rows"]
    need = {"№": None, "АЗС": None, "Текст обращения": None}  # столбцы по названию из шапки
    for name in need:
        need[name] = next((i for i, c in enumerate(columns) if c.strip().lower() == name.lower()), None)
        if need[name] is None:
            raise StopRun(f"В файле {src.name} нет столбца «{name}». Есть: {', '.join(columns)}.")
    manual, items, seen = [], [], set()
    for row in rows:
        num, azs, text = (row[need[n]].strip() for n in need)
        key = (azs.lower(), " ".join(text.lower().split()))
        if text and key in seen:
            items.append((row, num, azs, text, "повтор", "повтор, посчитан один раз"))
            continue
        seen.add(key)
        cat, why = classify(text, slovar)
        if cat == MANUAL:
            manual.append((row, why))
        items.append((row, num, azs, text, cat, why))
    items.sort(key=lambda x: x[4] != MANUAL)  # «разобрать вручную» первыми
    by_cat, by_azs = {}, {}
    for row, num, azs, text, cat, why in items:
        if cat in ("повтор", MANUAL):
            continue
        by_cat[cat] = by_cat.get(cat, 0) + 1
        by_azs[azs] = by_azs.get(azs, 0) + 1
    out_cols = ["№", "АЗС", "Тема", "Текст"]
    files = [
        write_excel("obrashcheniya-po-temam.xlsx", {
            "Обращения": (out_cols + ["Почему"], [[n, a, c, t, w] for _, n, a, t, c, w in items]),
            "Сводка": (["Тема", "Обращений"], sorted(by_cat.items(), key=lambda x: -x[1])),
            "По АЗС": (["АЗС", "Обращений"], sorted(by_azs.items())),
        }),
        write_manual(columns, manual),
    ]
    repeats = sum(1 for x in items if x[4] == "повтор")
    top = ", ".join(f"{c} {n}" for c, n in sorted(by_cat.items(), key=lambda x: -x[1])[:3])
    summary = (f"Обращений {len(rows)}, повторов {repeats}. Чаще всего: {top}. "
               f"Разобрать вручную: {len(manual)} (файл razobrat-vruchnuyu.xlsx). Файл {src.name}.")
    result = {
        "title": TITLE,
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "status": "green",
        "summary": summary,
        "columns": out_cols,
        "rows": [[n, a, c, t] for _, n, a, t, c, _w in items],
        "row_status": ["info" if c == MANUAL else None for *_, c, _w in items],
        "row_note": [MANUAL if c == MANUAL else None for *_, c, _w in items],
        "files": files,
        "sverka": {
            "итоги": {"обращений": len(rows), "повторов": repeats},
            "по категориям": by_cat,
            "по строкам": {n: c for _, n, a, t, c, _w in items},
        },
    }
    write_result(result)
    print(result["summary"])
```

## Шаблон Word

Шаблон лежит рядом с программой: `processes/<имя>/shablon.docx`. Поле в шаблоне пишется в двойных фигурных скобках: `{{Наименование поставщика}}`. Человек может открыть шаблон в Word и поправить текст; поля оставляет как есть. Поля заполняются везде: в тексте, таблицах, надписях, элементах управления, во всех колонтитулах (и первой страницы бланка). Поле, до которого замена не достала, программа находит после заполнения и отправляет документ в «разобрать вручную». Оформление текста вокруг поля сохраняется.

Шаблона ещё нет: программа делает его сама при первом запуске:

- есть шаблон человека в `input/<имя>/`: в `SOURCE_TEMPLATE` имя этого файла. Программа берёт его целиком (оформление, бланк) и превращает поля в квадратных скобках в поля шаблона: `[дата]` станет `{{дата}}`;
- шаблона человека нет: текст шаблона из скилла в `SHABLON_TEXT`, по строке на абзац, поля в `{{...}}`.

Заполнение: `fill_docx(values, имя файла)`, где `values` это `{"поле": значение}`. Поле без данных (нет в `values`, `None` или пустая строка) получает «[нет данных]», а программа кладёт документ в «разобрать вручную» с перечнем таких полей. Поле, которое человек всегда заполняет сам (подпись, телефон), можно заполнить постоянной строкой из скилла, например «[уточнить]»: тогда документ не уходит в «разобрать вручную». Таблицу (список строк, первая строка: заголовки) можно поставить в поле, которое стоит в абзаце одно: на его месте будет таблица. Документы пиши в `output/<имя>/`, имена файлов латиницей: `pismo-01.docx`.

```python
# --- Шаблон Word: черновики по processes/<имя>/shablon.docx ---
NO_DATA = "[нет данных]"
TEMPLATE = HERE / "shablon.docx"
SOURCE_TEMPLATE = ""  # шаблон человека в input/<имя>/, например "pismo.docx"; нет такого файла: ""
SHABLON_TEXT = [  # шаблон из текста скилла, по строке на абзац; нужен, только если SOURCE_TEMPLATE пустой
    "{{Кому}}",
    "Уважаемые коллеги!",
    "{{Текст}}",
]
FIELD_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
BRACKET_RE = re.compile(r"\[([^\[\]]+)\]")
# Части документа с текстом: основной текст, все колонтитулы (и первой страницы, и чётных), сноски.
WORD_PARTS = re.compile(r"^/word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$")
# Куски текста абзаца, и внутри ссылок, правок, полей и элементов управления содержимым.
RUN_PATH = ("./w:r | ./w:hyperlink/w:r | ./w:ins/w:r | ./w:smartTag/w:r | ./w:fldSimple/w:r"
            " | ./w:customXml/w:r | ./w:sdt/w:sdtContent/w:r")


def load_docx():
    try:
        import docx
    except ImportError:
        raise StopRun("Не найдена библиотека python-docx для Word. Скажите Claude «проверь сетап».")
    return docx


def word_parts(doc):
    for part in doc.part.package.iter_parts():
        if WORD_PARTS.match(str(part.partname)):
            yield part


def paragraphs(doc):
    """Все абзацы документа: текст, таблицы, надписи, элементы управления, все колонтитулы, сноски."""
    from docx.oxml.ns import qn
    from docx.text.paragraph import Paragraph
    for part in word_parts(doc):
        root = getattr(part, "element", None)  # часть без разбора python-docx: её проверяет leftover_fields
        if root is not None:
            for p in root.iter(qn("w:p")):
                yield Paragraph(p, part)


def replace_fields(p, pattern, func):
    """Замена полей в абзаце. Поле внутри одного куска текста заменяется в нём. Поле, которое Word разбил
    на несколько кусков, собирается в первый из них, а остальные куски этого поля укорачиваются:
    текст вне полей и его оформление (жирный, курсив) не меняются."""
    from docx.text.run import Run
    pos = 0
    while True:
        runs = [Run(r, p) for r in p._p.xpath(RUN_PATH)]
        texts = [r.text for r in runs]
        m = pattern.search("".join(texts), pos)
        if not m:
            return
        new = func(m)
        starts, at = [], 0
        for t in texts:
            starts.append(at)
            at += len(t)
        first = next(i for i, t in enumerate(texts) if starts[i] <= m.start() < starts[i] + len(t))
        last = next(i for i, t in enumerate(texts) if starts[i] < m.end() <= starts[i] + len(t))
        if first == last:
            t = texts[first]
            runs[first].text = t[:m.start() - starts[first]] + new + t[m.end() - starts[first]:]
        else:
            runs[first].text = texts[first][:m.start() - starts[first]] + new
            for i in range(first + 1, last):
                runs[i].text = ""
            runs[last].text = texts[last][m.end() - starts[last]:]
        pos = m.start() + len(new)


def leftover_fields(doc):
    """Поля {{...}}, которые остались в документе после заполнения (в любой части, и в сносках)."""
    from docx.oxml.ns import qn
    found = []
    for part in word_parts(doc):
        root = getattr(part, "element", None)
        if root is not None:
            texts = ["".join(t.text or "" for t in p.iter(qn("w:t"))) for p in root.iter(qn("w:p"))]
        else:
            xml = part.blob.decode("utf-8", "replace")
            texts = ["".join(re.findall(r"<w:t(?:\s[^>]*)?>([^<]*)</w:t>", x))
                     for x in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)]
        found += [f.strip() for t in texts for f in FIELD_RE.findall(t)]
    return found


def ensure_template():
    """processes/<имя>/shablon.docx: есть, берём его (человек мог поправить его в Word). Нет: делаем."""
    if TEMPLATE.is_file():
        return TEMPLATE
    docx = load_docx()
    if SOURCE_TEMPLATE:
        src = ROOT / "input" / SLUG / SOURCE_TEMPLATE
        if not src.is_file():
            raise StopRun(f"Нет шаблона input/{SLUG}/{SOURCE_TEMPLATE}. Положите его в папку и запустите снова.")
        doc = docx.Document(src)
        for p in list(paragraphs(doc)):
            replace_fields(p, BRACKET_RE, lambda m: "{{" + m.group(1).strip() + "}}")
    else:
        doc = docx.Document()
        for line in SHABLON_TEXT:
            doc.add_paragraph(line)
    tmp = TEMPLATE.with_name(TEMPLATE.name + ".tmp")
    doc.save(tmp)
    os.replace(tmp, TEMPLATE)
    return TEMPLATE


def field_key(name):
    return " ".join(str(name).lower().replace("ё", "е").split())


def put_table(doc, p, rows):
    """Таблица на месте абзаца с полем: rows = список строк, первая строка заголовки."""
    width = max(len(r) for r in rows)
    table = doc.add_table(rows=0, cols=width)
    try:
        table.style = "Table Grid"
    except Exception:
        pass  # в шаблоне человека нет такого стиля: таблица без рамок
    for r in rows:
        cells = table.add_row().cells
        for i, v in enumerate(r):
            cells[i].text = "" if v is None else str(v)
    p._p.addprevious(table._tbl)
    if p._p.getparent().tag.endswith("}tc"):
        p.text = ""  # ячейка Word должна кончаться абзацем: он остаётся после таблицы пустым
    else:
        p._p.getparent().remove(p._p)


def fill_docx(values, name):
    """Документ output/<имя>/<name> по шаблону. Возвращает (путь для files, поля без данных)."""
    docx = load_docx()
    doc = docx.Document(ensure_template())
    known = {field_key(k): v for k, v in values.items()}
    missing = []

    def value(m):
        v = known.get(field_key(m.group(1)))
        if v is None or isinstance(v, list) or not str(v).strip():
            missing.append(m.group(1).strip())
            return NO_DATA
        return str(v)

    for p in list(paragraphs(doc)):
        m = FIELD_RE.fullmatch(p.text.strip())
        v = known.get(field_key(m.group(1))) if m else None
        if isinstance(v, list) and v:
            put_table(doc, p, v)
        else:
            replace_fields(p, FIELD_RE, value)
    missing += leftover_fields(doc)  # поле там, куда замена не достаёт: документ тоже человеку
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / name
    tmp = target.with_name(target.name + ".tmp")
    doc.save(tmp)
    replace_file(tmp, target)
    return f"output/{SLUG}/{name}", sorted(set(missing))


def money(v):
    """Сумма для письма: 1250000 → «1 250 000,00». None: None (поле получит «[нет данных]»)."""
    if v is None:
        return None
    return f"{v:,.2f}".replace(",", " ").replace(".", ",")
```

Пример `main` для черновика (по документу на строку таблицы):

```python
def main():
    src = newest_input((".xlsx", ".csv"))
    table = read_table.analyze(src, None, LIMIT)
    columns, rows = table["columns"], table["rows"]
    col = {c.strip().lower(): i for i, c in enumerate(columns)}
    for name in ("поставщик", "сумма"):
        if name not in col:
            raise StopRun(f"В файле {src.name} нет столбца «{name}». Есть: {', '.join(columns)}.")
    manual, docs, files = [], [], []
    for n, row in enumerate(rows, start=1):
        supplier = row[col["поставщик"]].strip()
        values = {
            "Наименование поставщика": supplier,
            "дата": "21.09.2026",
            "Сумма": money(number(row[col["сумма"]])),
            "Фамилия И. О.": "[уточнить]",  # подпись человек ставит сам: так в скилле
        }
        path, missing = fill_docx(values, f"pismo-{n:02d}.docx")
        files.append(path)
        if missing:
            manual.append((row, "нет данных: " + ", ".join(missing)))
        docs.append((supplier, values["Сумма"], path.split("/")[-1], bool(missing)))
    docs.sort(key=lambda d: not d[3])  # «разобрать вручную» первыми
    files.append(write_manual(columns, manual))
    summary = (f"Писем {len(docs)} на 21.09.2026. Разобрать вручную: {len(manual)} "
               f"(файл razobrat-vruchnuyu.xlsx). Файл {src.name}.")
    result = {
        "title": TITLE,
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "status": "green",
        "summary": summary,
        "columns": ["Поставщик", "Сумма", "Файл"],
        "rows": [[s, v, f] for s, v, f, _m in docs],
        "row_status": ["info" if m else None for *_x, m in docs],
        "row_note": [MANUAL if m else None for *_x, m in docs],
        "files": files,
        "sverka": {
            "документов": len(docs),
            "по строкам": {s: (MANUAL if m else v) for s, v, _f, m in docs},
        },
    }
    write_result(result)
    print(result["summary"])
```

## Два документа Word

Для процесса, который сверяет документ с образцом: договор поставщика с типовой формой, документ с шаблоном. Оба файла лежат в `input/<имя>/`. Типовую форму программа узнаёт по части имени файла (`FORM_PART`, её подтверждает человек), второй файл Word считается договором. Чтение Word блок берёт из блока «Шаблон Word»: вставь сначала его, за ним этот.

Правило сверки (его же простыми словами объясняй человеку):

- документ делится на разделы по заголовкам («4. Цена и порядок расчётов», «Приложение 1. Спецификация»); всё до первого раздела называется шапкой (название, место и дата, стороны). Номер пункта программа берёт из текста («4.2.»); абзац без номера получает номер вида «11, абз. 1». Нумерация списком Word в текст не входит, такие пункты тоже получат «абз.»;
- разделы сопоставляются по заголовку без номера: большие и маленькие буквы, пробелы, ё и кавычки не важны. После удалённого раздела номера следующих разделов сдвигаются, и это отличием не считается: пункт 10.1 формы стоит в договоре под номером 9.1 и «совпадает»;
- пункты внутри пары разделов сопоставляются по тексту, номер пункта не важен. Пункта формы нет в договоре: «удалён»; пункта договора нет в форме: «добавлен»; раздела формы нет в договоре: «удалён» одной строкой на весь раздел;
- поле формы для заполнения (`[дата]`, `____`, `«___»`, пустые кавычки «») совпадает с любым текстом договора на его месте: заполненные номер, дата, поставщик, сумма и реквизиты отличием не считаются. Служебная пометка формы без номера пункта («Типовая форма ...», слова из `FORM_NOTES`) не сравнивается;
- «изменён (мелкая правка)»: текст почти тот же (похож на 90% и больше) и числа в нём те же, например «3 (трёх) рабочих дней» и «трёх рабочих дней». Числа словами программа узнаёт по списку `NUMBER_WORDS`; число прописью в скобках после цифр считается тем же числом;
- каждый пункт с отличием уходит в «разобрать вручную» с причиной «оценить риск: решает юрист». Отличие находит программа, оценивает его человек.

Ещё блок проверяет цифры и собирает карточку:

- спецификация: количество × цена по каждой строке, итог по строкам против строки «Итого», сумма договора из пункта карточки «Сумма» (в типовой форме 4.1) против пересчёта; количества спецификации против технической спецификации по наименованию товара. Числа вида `46 400 000,00` (между разрядами бывает неразрывный пробел) читает `number()` из основы. Число, которое не прочиталось, уходит в «разобрать вручную»;
- карточка условий: стороны по словам «именуемое в дальнейшем «Поставщик»» (`PARTIES`), номер и дата из шапки, остальное по списку `CARD`: текст пункта, найденного по заголовку раздела или по словам в тексте. Не нашлось: «[нет данных]» и строка в «разобрать вручную».

Раздел `sverka`: в `по строкам` только пункты с отличием, ключ «пункт формы / пункт договора»: «4.2», если номер тот же, иначе «10.1/9.1», «нет/4.4», «9/нет»; значение статус («изменён», «изменён (мелкая правка)», «добавлен», «удалён»). Совпавшие пункты в `по строкам` не пишутся: эталон скилла и есть его таблица отличий. Пункт с отличием лежит в «разобрать вручную» ради оценки риска; в `по строкам` у него статус, который программа определила сама. `итоги`: изменено, добавлено, удалено, мелких правок, разница спецификации (итог в документе минус пересчёт).

```python
# --- Два документа Word: документ против образца (договор поставщика против типовой формы) ---
# Чтение Word (load_docx, word_parts), NO_DATA и money берёт из блока «Шаблон Word»: он стоит в программе выше.
import difflib

FORM_PART = "forma"  # часть имени файла типовой формы в input/<имя>/, её подтвердил человек; второй .docx: договор
FORM_NOTES = ["типовая форма"]  # служебная пометка формы (абзац без номера с этими словами): не сравнивается
PARTIES = ["Поставщик", "Покупатель"]  # стороны, как их называет договор: «именуемое в дальнейшем «Поставщик»»
# Карточка условий: (строка карточки, где искать, слова). «раздел»: все пункты раздела с этими словами
# в заголовке; «пункт»: первый пункт с ними в тексте. Регистр и ё не важны, варианты слов через |.
CARD = [
    ("Предмет", "пункт", "обязуется поставить"),
    ("Сумма", "пункт", "сумма договора"),
    ("Оплата", "пункт", "оплачивает|предоплат"),
    ("Срок поставки", "пункт", "срок поставки"),
    ("Неустойки", "раздел", "ответственность"),
    ("Срок действия", "раздел", "срок действия"),
    ("Споры", "раздел", "споров"),
]
SUM_CARD = "Сумма"  # строка карточки с суммой договора: её сверяем с пересчётом спецификации
SPEC_SECTION, TECH_SECTION = "спецификац", "техническ"  # слова в заголовках разделов со спецификациями
MATCH, CHANGED, MINOR_EDIT = "совпадает", "изменён", "изменён (мелкая правка)"
ADDED, DELETED = "добавлен", "удалён"
MINOR = 0.9  # мелкая правка: текст похож на 90% и больше, числа те же
PAIR_MIN = 0.3  # пункт между совпавшими пунктами: пара «изменён», если текст похож хотя бы на 30%
HEAD = "шапка"  # всё до первого раздела: название, место и дата, стороны
BLANK_RE = re.compile(r"\[[^\[\]]*\]|_{2,}|«[\s_]*»")  # поле формы для заполнения: [дата], ____, «___», «»
POINT_RE = re.compile(r"(\d+(?:\.\d+)+)\.?\s+(.+)", re.S)  # «4.2. Покупатель ...»
SECTION_RE = re.compile(r"(?:раздел\s+)?(\d+)\.?\s+(\D.*)", re.S | re.I)  # «4. Цена и порядок расчётов»
DOC_NO_RE = re.compile(r"№\s*([^\s,]+)")
DATE_RE = re.compile(r"\d{1,2}\.\d{1,2}\.\d{4}|«?\d{1,2}»?\s+(?:января|февраля|марта|апреля|мая|июня|июля|"
                     r"августа|сентября|октября|ноября|декабря)\s+\d{4}", re.I)
PARTY_RE = re.compile(r"([^,]+?),\s*(?:именуем\w*\s+)?(?:в\s+дальнейшем|далее)\s+«([^»]+)»", re.I)
NUM_RE = re.compile(r"\d{1,3}(?:\s\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?")  # где в тексте число; читает его number()
SPELLED_RE = re.compile(r"(\d)\s*\([^()\d]*\)")  # «3 (трёх)»: пропись в скобках повторяет число
NUMBER_WORDS = {w: n for n, forms in (
    (1, "один одного одной"), (2, "два две двух"), (3, "три трех"), (4, "четыре четырех"), (5, "пять пяти"),
    (6, "шесть шести"), (7, "семь семи"), (8, "восемь восьми"), (9, "девять девяти"), (10, "десять десяти"),
    (14, "четырнадцать четырнадцати"), (15, "пятнадцать пятнадцати"), (20, "двадцать двадцати"),
    (30, "тридцать тридцати"), (60, "шестьдесят шестидесяти"), (90, "девяносто"),
) for w in forms.split()}
PATTERNS = {}  # текст пункта формы: образец для сравнения


def two_documents():
    """(типовая форма, договор): самые свежие файлы Word в input/<имя>/, форма по части имени FORM_PART."""
    folder = ROOT / "input" / SLUG
    docs = [p for p in folder.glob("*") if p.is_file() and p.suffix.lower() == ".docx"
            and not p.name.startswith(("~$", "."))]
    forms = [p for p in docs if FORM_PART.lower() in p.name.lower()]
    others = [p for p in docs if p not in forms]
    if not forms:
        raise StopRun(f"В папке input/{SLUG} нет типовой формы: файла Word, в имени которого есть «{FORM_PART}». "
                      "Положите её и запустите расчёт снова.")
    if not others:
        raise StopRun(f"В папке input/{SLUG} нет договора: второго файла Word рядом с формой. "
                      "Положите его и запустите расчёт снова.")
    form, doc = (max(group, key=lambda p: max(p.stat().st_mtime, p.stat().st_ctime)) for group in (forms, others))
    return form, doc


def norm(text):
    """Текст для сравнения: строчные, ё как е, без кавычек, пробелы по одному, без точки в конце."""
    t = re.sub(r"[«»\"“”„']", "", str(text).lower().replace("ё", "е"))
    return " ".join(t.split()).strip(" .,;:")


def blank_pattern(form_text):
    """Текст формы как образец: поле для заполнения совпадает с любым текстом на его месте."""
    if form_text not in PATTERNS:
        pieces = norm(BLANK_RE.sub("\x00", form_text)).split("\x00")
        PATTERNS[form_text] = re.compile("(.+?)".join(re.escape(p) for p in pieces), re.S)
    return PATTERNS[form_text]


def same_text(form_text, doc_text):
    """Пункт договора совпадает с пунктом формы: тот же текст, поля формы заполнены чем угодно."""
    return blank_pattern(form_text).fullmatch(norm(doc_text)) is not None


def numbers_in(text):
    """Числа текста по возрастанию: цифрами (читает number из основы) и словами из NUMBER_WORDS."""
    t = SPELLED_RE.sub(r"\1", str(text).lower().replace("ё", "е"))
    found = [number(m.group()) for m in NUM_RE.finditer(t)]
    found += [NUMBER_WORDS[w] for w in re.findall(r"[^\W\d_]+", t) if w in NUMBER_WORDS]
    return sorted(n for n in found if n is not None)


def pair_status(form_text, doc_text):
    """(похожесть от 0 до 1, статус) пары пунктов формы и договора."""
    if same_text(form_text, doc_text):
        return 1.0, MATCH
    bare = BLANK_RE.sub("", form_text)
    score = difflib.SequenceMatcher(None, norm(bare), norm(doc_text), autojunk=False).ratio()
    return score, (MINOR_EDIT if score >= MINOR and numbers_in(bare) == numbers_in(doc_text) else CHANGED)


def text_of(el):
    """Текст абзаца или ячейки целиком (и в полях, ссылках, элементах управления), пробелы по одному."""
    from docx.oxml.ns import qn
    t = qn("w:t")
    return " ".join("".join((n.text or "") if n.tag == t else " "
                            for n in el.iter(t, qn("w:tab"), qn("w:br"))).split())


def is_heading(p, text):
    """Заголовок раздела: стиль «Заголовок» или короткая строка «4. Название» или «Приложение ...» без точки."""
    if POINT_RE.fullmatch(text):
        return False
    style = (p.style.name if p.style is not None else "").lower()
    if style.startswith(("heading", "заголовок", "title")):
        return True
    return len(text) <= 100 and not text.endswith(".") and bool(
        SECTION_RE.fullmatch(text) or text.lower().startswith("приложение"))


def read_document(path, notes=()):
    """Документ Word по разделам: [{"label", "key", "heading", "items": [(номер, текст, абзац)], "tables"}].
    До первого раздела шапка, колонтитулы и сноски: свой раздел в конце. Номер пункта из текста («4.2.»),
    абзац без номера: «<раздел>, абз. N». notes: слова служебных пометок, такие абзацы без номера пропускаются."""
    docx = load_docx()
    from docx.oxml.ns import qn
    from docx.text.paragraph import Paragraph
    try:
        document = docx.Document(path)
    except Exception:
        raise StopRun(f"Файл {path.name} не открывается как документ Word. "
                      "Откройте его в Word, сохраните как .docx и запустите расчёт снова.")

    def section(label, key, heading):
        return {"label": label, "key": key, "heading": heading, "items": [], "tables": [], "plain": 0}

    body, tail = [section(HEAD, HEAD, "")], section("колонтитулы", "колонтитулы", "")
    w_p, w_tbl = qn("w:p"), qn("w:tbl")
    for part in word_parts(document):
        root = getattr(part, "element", None)
        if root is None:
            continue
        in_body = str(part.partname).endswith("document.xml")
        for el in root.iter(w_p, w_tbl):
            if next(el.iterancestors(w_tbl), None) is not None:
                continue  # внутри таблицы: текст уже в её строках
            here = body[-1] if in_body else tail
            if el.tag == w_tbl:
                here["tables"].append([[text_of(tc) for tc in tr.findall(qn("w:tc"))] for tr in el.findall(qn("w:tr"))])
                continue
            text = text_of(el)
            point = POINT_RE.fullmatch(text)
            if not text or (not point and any(norm(n) in norm(text) for n in notes)):
                continue
            if in_body and is_heading(Paragraph(el, part), text):
                m = SECTION_RE.fullmatch(text)
                if m or len(body) > 1 or text.lower().startswith("приложение"):
                    body.append(section(m.group(1) if m else text, norm(m.group(2) if m else text), text))
                    continue
                # заголовок без номера до первого раздела: название документа, оно в шапке
            if point:
                here["items"].append((point.group(1), point.group(2), text))
            else:
                here["plain"] += 1
                here["items"].append((f"{here['label']}, абз. {here['plain']}", text, text))
    return body + ([tail] if tail["items"] else [])


def pair_sections(form, doc):
    """{раздел договора: раздел формы} по заголовку без номера; чуть изменённый заголовок по похожести от 0,8."""
    pairs = {}
    for i, fs in enumerate(form):
        j = next((j for j, ds in enumerate(doc) if j not in pairs and ds["key"] == fs["key"]), None)
        if j is not None:
            pairs[j] = i
    near = sorted(((difflib.SequenceMatcher(None, fs["key"], ds["key"]).ratio(), i, j)
                   for i, fs in enumerate(form) for j, ds in enumerate(doc)), reverse=True)
    for score, i, j in near:
        if score >= 0.8 and j not in pairs and i not in pairs.values():
            pairs[j] = i
    return pairs


def pair_items(fitems, ditems):
    """Пары пунктов двух разделов по тексту, номер не важен: [(пункт формы или None, пункт договора или None,
    статус)] по порядку договора. Одинаковые пункты служат опорой, пункты между ними сопоставляются по похожести."""
    used, dtok = set(), []
    for j, d in enumerate(ditems):
        i = next((i for i, f in enumerate(fitems) if i not in used and same_text(f[1], d[1])), None)
        if i is not None:
            used.add(i)
        dtok.append(i if i is not None else -1 - j)
    out, left_f, left_d = [], [], []
    opcodes = difflib.SequenceMatcher(None, list(range(len(fitems))), dtok, autojunk=False).get_opcodes()
    for tag, i1, i2, j1, j2 in opcodes:
        if tag == "equal":
            out += [(i, j, MATCH) for i, j in zip(range(i1, i2), range(j1, j2))]
            continue
        free_f, free_d = set(range(i1, i2)), set(range(j1, j2))
        scored = sorted(((pair_status(fitems[i][1], ditems[j][1]), i, j) for i in free_f for j in free_d), reverse=True)
        for (score, status), i, j in scored:
            if score >= PAIR_MIN and i in free_f and j in free_d:
                out.append((i, j, status))
                free_f.discard(i)
                free_d.discard(j)
        left_f += sorted(free_f)
        left_d += sorted(free_d)
    for i in left_f:  # пункт переставлен в другое место раздела: тот же текст, «совпадает»
        j = next((j for j in left_d if same_text(fitems[i][1], ditems[j][1])), None)
        if j is None:
            out.append((i, None, DELETED))
        else:
            out.append((i, j, MATCH))
            left_d.remove(j)
    out += [(None, j, ADDED) for j in left_d]

    def place(row):  # по порядку договора; удалённый пункт сразу за тем, что стоял перед ним в форме
        i, j, _status = row
        if j is not None:
            return j, 0, 0
        return max((jj for ii, jj, _s in out if ii is not None and jj is not None and ii < i), default=-1), 1, i
    return sorted(out, key=place)


def compare_documents(form, doc):
    """Строки сверки по порядку договора: (пункт формы, пункт договора, ключ, статус, текст формы, текст договора).
    Ключ «4.2», если номер в форме и договоре тот же, иначе «10.1/9.1», «нет/4.4», «9/нет». Раздела формы
    нет в договоре: одна строка «удалён»; раздела договора нет в форме: одна строка «добавлен»."""
    pairs = pair_sections(form, doc)
    rows, done = [], set()

    def key(f, d):
        return f if f == d else f"{f or 'нет'}/{d or 'нет'}"

    def whole(s):
        return " ".join([s["heading"]] + [a for _n, _t, a in s["items"]]).strip()

    def deleted_before(k):
        for i in range(k):
            if i not in done and i not in pairs.values():
                done.add(i)
                rows.append((form[i]["label"], None, key(form[i]["label"], None), DELETED, whole(form[i]), None))

    for j, ds in enumerate(doc):
        if j not in pairs:
            rows.append((None, ds["label"], key(None, ds["label"]), ADDED, None, whole(ds)))
            continue
        fs = form[pairs[j]]
        deleted_before(pairs[j])
        for i, jj, status in pair_items(fs["items"], ds["items"]):
            f = fs["items"][i] if i is not None else (None, None, None)
            d = ds["items"][jj] if jj is not None else (None, None, None)
            rows.append((f[0], d[0], key(f[0], d[0]), status, f[2], d[2]))
    deleted_before(len(form))
    return rows


def contract_card(doc):
    """Карточка условий договора: [(условие, текст или None)]; None: в договоре не нашлось."""
    head = [a for _n, _t, a in doc[0]["items"]]
    parties = {}
    for text in head:
        for m in PARTY_RE.finditer(text):
            parties.setdefault(norm(m.group(2)), re.sub(r"^и\s+", "", m.group(1).strip()))
    doc_no = next((m.group(1) for m in map(DOC_NO_RE.search, head) if m), None)
    date = next((m.group() for m in map(DATE_RE.search, head) if m), None)
    card = [(p, parties.get(norm(p))) for p in PARTIES] + [("Номер", doc_no), ("Дата", date)]
    for name, where, words in CARD:
        found = [a for s in doc[1:] for _n, _t, a in s["items"]
                 if re.search(norm(words), norm(s["heading"] if where == "раздел" else a))]
        card.append((name, " ".join(found if where == "раздел" else found[:1]) or None))
    return card


def spec_table(doc, word, skip=""):
    """Первая таблица раздела, в заголовке которого есть word (и нет skip): строки, первая из них шапка."""
    for s in doc:
        title = norm(s["heading"])
        if word in title and not (skip and skip in title) and s["tables"]:
            return s["tables"][0]
    return None


def column(head, *words):
    return next((i for i, c in enumerate(head) if any(w in norm(c) for w in words)), None)


def diff(a, b):
    return round(a - b, 2) if a is not None and b is not None else None


def amount_text(v):
    """Количество для итога: 80000 → «80 000», нет числа: «нет»."""
    return "нет" if v is None else money(v).removesuffix(",00")


def check_spec(doc, sum_text):
    """Спецификация: количество × цена по каждой строке, итог, сумма договора (пункт sum_text) против пересчёта;
    количества против технической спецификации по наименованию товара. Словарь: rows и tech (строки листов),
    diff (итог в документе минус пересчёт), problems (что не сходится), unread [(что, почему)] человеку."""
    res = {"rows": [], "tech": [], "diff": None, "problems": [], "unread": []}
    spec, tech = spec_table(doc, SPEC_SECTION, TECH_SECTION), spec_table(doc, TECH_SECTION)
    products, total_doc = [], None
    if spec is None:
        res["unread"].append(("спецификация", "нет раздела спецификации с таблицей"))
    else:
        head, body = spec[0], spec[1:]
        col = [column(head, "товар", "наименован"), column(head, "количеств"), column(head, "цена"), column(head, "сумма")]
        if None in col:
            res["unread"].append(("спецификация", "нет столбца товара, количества, цены или суммы: " + ", ".join(head)))
            body = []
        calcs = []
        for cells in body:
            cells = cells + [""] * len(head)  # строка короче шапки (объединённые ячейки)
            name, (q, p, s) = cells[col[0]], [number(cells[c]) for c in col[1:]]
            if any(norm(c).startswith("итог") for c in cells):
                total_doc = s
                if s is None:
                    res["unread"].append(("спецификация, итого", f"сумма не числом: «{cells[col[3]]}»"))
                continue
            if not name:
                continue
            bad = [f"{h} «{cells[c]}»" for h, c, v in zip(("количество", "цена", "сумма"), col[1:], (q, p, s)) if v is None]
            if bad:
                res["unread"].append((f"спецификация, {name}", "не число: " + ", ".join(bad)))
            calc = round(q * p, 2) if q is not None and p is not None else None
            calcs.append(calc)
            products.append((name, q))
            res["rows"].append([name, q, p, s, calc, diff(s, calc)])
        total_calc = round(sum(calcs), 2) if calcs and None not in calcs else None
        res["diff"] = diff(total_doc, total_calc)
        point = POINT_RE.fullmatch(sum_text or "")
        label = f"Сумма договора, п. {point.group(1)}" if point else "Сумма договора"
        # сумма: самое большое число цифрами в тексте пункта без его номера (прописью не считается)
        amounts = [n for n in map(number, NUM_RE.findall(point.group(2) if point else sum_text or "")) if n is not None]
        amount = max(amounts, default=None)
        if sum_text and amount is None:
            res["unread"].append((label, "в тексте пункта нет суммы числом"))
        res["rows"] += [["Итого", None, None, total_doc, total_calc, res["diff"]],
                        [label, None, None, amount, total_calc, diff(amount, total_calc)]]
        res["problems"] += [f"{r[0]}: {money(r[3])} при пересчёте {money(r[4])}" for r in res["rows"] if r[5]]
    if tech is None:
        res["unread"].append(("техническая спецификация", "нет раздела технической спецификации с таблицей"))
        return res
    head, body = tech[0], tech[1:]
    ci, cq = column(head, "товар", "наименован"), column(head, "количеств")
    if ci is None or cq is None:
        res["unread"].append(("техническая спецификация", "нет столбца товара или количества: " + ", ".join(head)))
        body = []
    qty, seen = {norm(n): q for n, q in products}, set()
    for cells in body:
        cells = cells + [""] * len(head)
        name, t = cells[ci], number(cells[cq])
        if not name or norm(name).startswith("итог"):
            continue
        if t is None:
            res["unread"].append((f"техническая спецификация, {name}", f"количество не числом: «{cells[cq]}»"))
        seen.add(norm(name))
        res["tech"].append([name, qty.get(norm(name)), t, diff(qty.get(norm(name)), t)])
    res["tech"] += [[n, q, None, None] for n, q in products if norm(n) not in seen]
    if products:
        res["problems"] += [f"{n}: в спецификации {amount_text(s)}, в технической {amount_text(t)}"
                            for n, s, t, d in res["tech"] if d != 0]
    return res
```

Пример `main` для сверки двух документов (договор поставщика против типовой формы):

```python
def main():
    form_path, doc_path = two_documents()
    form, doc = read_document(form_path, FORM_NOTES), read_document(doc_path)
    rows = compare_documents(form, doc)  # (пункт формы, пункт договора, ключ, статус, текст формы, текст договора)
    card = contract_card(doc)
    spec = check_spec(doc, dict(card).get(SUM_CARD))
    out_cols = ["Пункт", "Что", "Типовая форма", "Договор"]
    # Отличие находит программа, оценку риска делает человек: каждое отличие в «разобрать вручную».
    manual = [([k, st, ft, dt], "оценить риск: решает юрист") for _f, _d, k, st, ft, dt in rows if st != MATCH]
    manual += [([f"карточка: {n}", NO_DATA, None, None], "не нашлось в договоре") for n, v in card if v is None]
    manual += [([what, None, None, None], why) for what, why in spec["unread"]]
    same = [[k, st, ft, dt] for _f, _d, k, st, ft, dt in rows if st == MATCH]
    count = {st: sum(1 for r in rows if r[3] == st) for st in (CHANGED, MINOR_EDIT, ADDED, DELETED)}
    files = [
        write_excel("sverka-dogovora.xlsx", {
            "Отличия": (["Пункт формы", "Пункт договора", "Что", "Типовая форма", "Договор"],
                        [[f or "нет", d or "нет", st, ft, dt] for f, d, _k, st, ft, dt in rows]),
            "Спецификация": (["Товар", "Количество", "Цена", "В договоре", "Пересчёт", "Разница"], spec["rows"]),
            "Техспецификация": (["Товар", "В спецификации", "В технической спецификации", "Разница"], spec["tech"]),
            "Карточка условий": (["Условие", "Значение"], [[n, NO_DATA if v is None else v] for n, v in card]),
        }),
        write_manual(out_cols, manual),
    ]
    summary = (f"Договор {doc_path.name} против формы {form_path.name}: изменено {count[CHANGED]}, "
               f"мелких правок {count[MINOR_EDIT]}, добавлено {count[ADDED]}, удалено {count[DELETED]}. ")
    if spec["problems"]:
        summary += "Цифры не сходятся: " + "; ".join(spec["problems"]) + ". "
    elif spec["rows"]:
        summary += "Цифры спецификации сходятся. "
    summary += f"Разобрать вручную: {len(manual)} (файл razobrat-vruchnuyu.xlsx)."
    result = {
        "title": TITLE,
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "status": "yellow" if spec["problems"] else "green",  # цифры не сходятся: тревога по скиллу
        "summary": summary,
        "columns": out_cols,
        "rows": [values for values, _why in manual] + same,  # «разобрать вручную» первыми
        "row_status": ["info"] * len(manual) + [None] * len(same),
        "row_note": [MANUAL] * len(manual) + [None] * len(same),
        "files": files,
        "sverka": {
            "итоги": {"изменено": count[CHANGED], "добавлено": count[ADDED], "удалено": count[DELETED],
                      "мелких правок": count[MINOR_EDIT], "разница спецификации": spec["diff"]},
            "по строкам": {k: st for _f, _d, k, st, _ft, _dt in rows if st != MATCH},
        },
    }
    write_result(result)
    print(result["summary"])
```
