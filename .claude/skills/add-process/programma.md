# Программа процесса: образцы

Справка к операции «добавить процесс» (`.claude/skills/add-process/SKILL.md`, шаг 5) и к фразе «доработай <процесс>». Программа `processes/<имя>/run.py` работает без Claude и без интернета: её запускают кнопка «Запустить» и фраза «запусти <процесс>». Поэтому в ней нет вызова ИИ: только стандартный Python, openpyxl, python-docx и `tools/read_table.py`, без файлов вне кабинета.

Собери программу так:

1. Возьми «Основу» целиком.
2. Классификация: вставь блок «Словарь» после функций основы, перед `main`. Черновик: блок «Шаблон Word». Оба, если скилл и раскладывает, и пишет документы.
3. Напиши `main` по скиллу. Для классификации и черновика есть готовые примеры `main` ниже: возьми подходящий и поменяй столбцы, категории и поля под скилл и файл человека.

Процесс сверяет два документа Word (договор поставщика против типовой формы, документ против шаблона): прочитай ещё целиком `.claude/skills/add-process/programma-dva-dokumenta.md`. Там правило сверки, блок «Два документа Word» и пример `main` к нему; основа и блок «Шаблон Word» берутся отсюда.

Человеку говори «программа процесса», не «скрипт» и не «код».

## Правила для любой программы

- Расчёт по скиллу и по ответам человека. Столбцы ищи по названию из шапки, которую показал `read_table.py`, не по номеру. Строки над шапкой (заголовок отчёта, поставщик, период) программа берёт из `table["above_header"]`: список строк, в каждой непустые ячейки текстом.
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
- черновик: в документе осталась пометка (поле без данных или пометка из скилла: «[нет данных]», «[уточнить]», «[уточнить: что]»);
- сводная, сверка, реестр: строка, которую не прочитать (сумма не числом, неизвестная станция), если скилл не говорит, как с ней быть.

Каждую такую строку программа кладёт в список `manual` с причиной. Дальше:

- файл `output/<имя>/razobrat-vruchnuyu.xlsx`: функция `write_manual`, пишется при каждом запуске, даже пустой;
- строки на карточке с пометкой: `row_status` `info`, `row_note` «разобрать вручную». Если таблица на карточке по строкам файла (классификация, черновики), эти строки идут первыми. Если таблица на карточке сводная, добавь их в конец, по строке на каждую: в первом столбце номер строки файла и причина, остальные ячейки `None`; больше 50 не добавляй, остальные в файле;
- в итоге счётчик: «Разобрать вручную: 5 (файл razobrat-vruchnuyu.xlsx).»;
- в `files` ссылка на `razobrat-vruchnuyu.xlsx`, её возвращает `write_manual`.

## Раздел sverka для сверки со скиллом

Программа кладёт в `result.json` поле `sverka` с теми же разделами и теми же названиями, что в эталоне `output/<имя>/etalon-skilla.json`. Сверку делает `node tools/processes.mjs compare <имя>`. Разделы:

- `итоги`: `{"название": число или текст}`, те же названия, что в эталоне;
- `по категориям`: `{"категория": число строк или сумма}`; для сводной все группы основной таблицы, ключ группы по двум столбцам как в эталоне: `"АЗС-01 / АИ-92"`;
- `документов`: сколько документов Word сделала программа;
- `по строкам`: `{"номер или ключ строки": категория или ключевое значение}`; строка, отложенная человеку, получает значение «разобрать вручную». Ключ: номер строки из файла (столбец «№», если он есть) или другое значение, которое однозначно называет строку.

Раздел, которого нет в эталоне, можно не писать.

Эталон по части большого файла (скилл выполнен на первых 100 строках) записывает поле `"строк в эталоне": 100` и только раздел `по строкам`. Программа всё равно пишет `по строкам` для всех строк файла: сверка сравнивает только строки эталона, остальные называет «не входят в эталон» и расхождением не считает. Сводная, где групп больше 300: эталон пишет первые 100 групп в `по строкам` (ключ: группа), программа пишет туда все свои группы тем же ключом.

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

Какие слова брать: слова и короткие формы, по которым тему видно и на следующей неделе, то есть предмет темы: «бонус», «касса», «туалет», «колонка». Цитаты и редкие обороты отдельных строк («закатил глаза», названия моделей телефонов) в словарь не бери: на этой неделе они совпадут, на следующей их в строках уже не будет. Строка, которую без такой цитаты не разобрать, уходит в «разобрать вручную».

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

Заполнение: `fill_docx(values, имя файла)`, где `values` это `{"поле": значение}`. Поле без данных (нет в `values`, `None` или пустая строка) получает пометку `NO_DATA`. Пометку бери из скилла человека: скилл пишет «[уточнить]» или «[уточнить: что]», и программа пишет так же (`NO_DATA = "[уточнить]"`, пояснение для одного поля значением `"[уточнить: номер договора]"`); в скилле пометки нет: «[нет данных]». Любой документ, где после заполнения осталась пометка (поле без данных, значение с пометкой, пометка в тексте самого шаблона), программа кладёт в «разобрать вручную» с перечнем таких полей. Поле, которое человек всегда заполняет сам (подпись, телефон, должность): значение, которое он назвал на шаге 4, постоянной строкой; не назвал: `None`, в документе пометка, документ в «разобрать вручную». Таблицу (список строк, первая строка: заголовки) можно поставить в поле, которое стоит в абзаце одно: на его месте будет таблица. Документы пиши в `output/<имя>/`, имена файлов латиницей: `pismo-01.docx`.

```python
# --- Шаблон Word: черновики по processes/<имя>/shablon.docx ---
NO_DATA = "[нет данных]"  # пометка поля без данных; скилл человека пишет «[уточнить]»: здесь "[уточнить]"
TEMPLATE = HERE / "shablon.docx"
SOURCE_TEMPLATE = ""  # шаблон человека в input/<имя>/, например "pismo.docx"; нет такого файла: ""
SHABLON_TEXT = [  # шаблон из текста скилла, по строке на абзац; нужен, только если SOURCE_TEMPLATE пустой
    "{{Кому}}",
    "Уважаемые коллеги!",
    "{{Текст}}",
]
FIELD_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
BRACKET_RE = re.compile(r"\[([^\[\]]+)\]")
# Пометка в документе: NO_DATA, «[уточнить]», «[нет данных]», и с пояснением: «[уточнить: номер договора]».
MARK_RE = re.compile(r"\[\s*(?:уточнить|нет данных|%s)\s*(?::[^\[\]]*)?\]"
                     % re.escape(NO_DATA.strip("[] ").split(":")[0].strip().lower()), re.I)
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


def doc_texts(doc):
    """Текст каждого абзаца во всех частях документа, и в тех, что python-docx не разбирает (сноски)."""
    from docx.oxml.ns import qn
    texts = []
    for part in word_parts(doc):
        root = getattr(part, "element", None)
        if root is not None:
            texts += ["".join(t.text or "" for t in p.iter(qn("w:t"))) for p in root.iter(qn("w:p"))]
        else:
            xml = part.blob.decode("utf-8", "replace")
            texts += ["".join(re.findall(r"<w:t(?:\s[^>]*)?>([^<]*)</w:t>", x))
                      for x in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)]
    return texts


def leftover_fields(doc):
    """Поля {{...}}, которые остались в документе после заполнения (в любой части, и в сносках)."""
    return [f.strip() for t in doc_texts(doc) for f in FIELD_RE.findall(t)]


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
    """Документ output/<имя>/<name> по шаблону. Возвращает (путь для files, поля с пометкой).

    Поле без данных получает NO_DATA. Документ, где после заполнения осталась пометка (поле без данных,
    значение с пометкой «[уточнить: ...]», пометка в тексте самого шаблона), программа отдаёт человеку."""
    docx = load_docx()
    doc = docx.Document(ensure_template())
    known = {field_key(k): v for k, v in values.items()}
    missing, marked = [], []

    def value(m):
        v = known.get(field_key(m.group(1)))
        if v is None or isinstance(v, list) or not str(v).strip():
            v = NO_DATA
        found = MARK_RE.findall(str(v))
        if found:
            missing.append(m.group(1).strip())
            marked.extend(found)
        return str(v)

    for p in list(paragraphs(doc)):
        m = FIELD_RE.fullmatch(p.text.strip())
        v = known.get(field_key(m.group(1))) if m else None
        if isinstance(v, list) and v:
            put_table(doc, p, v)
        else:
            replace_fields(p, FIELD_RE, value)
    missing += leftover_fields(doc)  # поле там, куда замена не достаёт: документ тоже человеку
    left = [mk for t in doc_texts(doc) for mk in MARK_RE.findall(t)]
    for mk in marked:  # пометки, которые поставили поля, уже названы по имени поля
        if mk in left:
            left.remove(mk)
    missing += left  # пометка в тексте шаблона или в ячейке таблицы: документ тоже человеку
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / name
    tmp = target.with_name(target.name + ".tmp")
    doc.save(tmp)
    replace_file(tmp, target)
    return f"output/{SLUG}/{name}", sorted(set(missing))


def money(v):
    """Сумма для письма: 1250000 → «1 250 000,00». None: None (поле получит пометку NO_DATA)."""
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
            # Подпись: значение, которое человек назвал на шаге 4, постоянной строкой. Не назвал: None,
            # в письме пометка NO_DATA, и письмо уходит в «разобрать вручную».
            "Фамилия И. О.": "А. Иванов",
        }
        path, missing = fill_docx(values, f"pismo-{n:02d}.docx")
        files.append(path)
        if missing:
            manual.append((row, "поля с пометкой: " + ", ".join(missing)))
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
