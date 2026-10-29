// Карточки процессов для страницы «Мой кабинет». Чистые функции: данные процесса на входе, HTML-строка на выходе.
// Страница подключает файл обычным <script src="render.js"> и получает window.CabinetRender.
(function (global) {
  'use strict';

  var STATUS_LABEL = { red: 'красный', yellow: 'жёлтый', green: 'зелёный' };
  var ROW_LABEL = { red: 'красный', yellow: 'жёлтый', green: 'зелёный', grey: 'нет данных', info: '' };
  var ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return ENTITIES[c];
    });
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // 2026-10-22T14:05:09 → 22.10.2026 14:05 по часам компьютера.
  function formatTime(iso) {
    var d = new Date(String(iso).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(iso);
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function cellText(v) {
    if (v === true) return 'да';
    if (v === false) return 'нет';
    return v == null ? '' : String(v);
  }

  // Ссылка на файл результата: только output/<slug>/..., каждая часть пути кодируется.
  function fileHref(path, slug) {
    var parts = String(path).replace(/\\/g, '/').split('/');
    if (parts.length < 3 || parts[0] !== 'output' || parts[1] !== slug) return null;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '' || parts[i] === '.' || parts[i] === '..' || parts[i].indexOf(':') !== -1) return null;
    }
    return parts.map(encodeURIComponent).join('/');
  }

  function renderTable(r) {
    var columns = Array.isArray(r.columns) ? r.columns : [];
    var rows = Array.isArray(r.rows) ? r.rows : [];
    if (!columns.length && !rows.length) return '';
    var status = Array.isArray(r.row_status) ? r.row_status : null;
    var note = Array.isArray(r.row_note) ? r.row_note : null;
    var marks = Boolean(status || note);
    var head = (marks ? '<th class="mark">Отметка</th>' : '') + columns.map(function (c) {
      return '<th>' + esc(c) + '</th>';
    }).join('');
    var body = rows.map(function (row, i) {
      var st = status && ROW_LABEL.hasOwnProperty(status[i]) ? status[i] : null;
      var label = (note && note[i]) || (st ? ROW_LABEL[st] : '');
      var cells = (Array.isArray(row) ? row : []).map(function (v) {
        return '<td>' + esc(cellText(v)) + '</td>';
      }).join('');
      return (st ? '<tr class="row-' + st + '">' : '<tr>') + (marks ? '<td class="mark">' + esc(label) + '</td>' : '') + cells + '</tr>';
    }).join('');
    return '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function renderFiles(r, slug) {
    var links = (Array.isArray(r.files) ? r.files : []).map(function (f) {
      var href = fileHref(f, slug);
      if (!href) return '';
      var name = String(f).replace(/\\/g, '/').split('/').pop();
      return '<a href="' + esc(href) + '" download>' + esc(name) + '</a>';
    }).filter(Boolean);
    return links.length ? '<p class="files">Файлы: ' + links.join(', ') + '</p>' : '';
  }

  // Кнопка «Запустить» (kind script) или подсказка с фразой (kind claude): в шапке карточки, над таблицей.
  function renderActions(p) {
    if (p.kind === 'script') {
      return '<div class="actions">' + (p.running
        ? '<button type="button" class="run" data-run="' + esc(p.slug) + '" disabled>идёт расчёт…</button>'
        : '<button type="button" class="run" data-run="' + esc(p.slug) + '">Запустить</button>') + '</div>';
    }
    if (p.kind === 'claude') {
      return '<div class="actions"><p class="hint">Запуск фразой в Claude: «' + esc(p.phrase) + '»</p></div>';
    }
    return '';
  }

  // p: { slug, title, phrase, kind, result, error, running } из api/processes.
  // ui.message: короткий текст об ошибке запуска с этой страницы.
  function renderCard(p, ui) {
    var r = p.result;
    var html = '<article class="card" data-slug="' + esc(p.slug) + '"><div class="card-head"><div class="card-title"><h2>' + esc(p.title) + '</h2>';
    if (r && STATUS_LABEL.hasOwnProperty(r.status)) {
      html += '<span class="badge badge-' + r.status + '">' + STATUS_LABEL[r.status] + '</span>';
    }
    html += '</div>' + renderActions(p) + '</div>';
    if (ui && ui.message) html += '<p class="run-error" role="alert">' + esc(ui.message) + '</p>';
    if (r) {
      html += '<p class="updated">обновлено ' + esc(formatTime(r.updated_at)) + '</p>';
      if (r.summary) html += '<p class="summary">' + esc(r.summary) + '</p>';
      html += renderTable(r) + renderFiles(r, p.slug);
    } else if (!p.error) {
      html += '<p class="updated">ещё не запускался</p>';
    }
    if (p.error) html += '<p class="error">Ошибка: ' + esc(p.error) + '</p>';
    return html + '</article>';
  }

  // messages: { slug: текст } для карточек, где запуск не удался.
  function renderPage(list, messages) {
    if (!list || !list.length) {
      return '';  // своих сервисов пока нет: на странице только «Спроси таблицу» (решение Дмитрия 29.10)
    }
    return list.map(function (p) {
      return renderCard(p, { message: messages && messages[p.slug] });
    }).join('');
  }

  global.CabinetRender = { renderCard: renderCard, renderPage: renderPage, formatTime: formatTime };
})(window);
