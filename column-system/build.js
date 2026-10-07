/**
 * Solid Grow Prosper ホームページ
 * コラム・お知らせ 自動更新スクリプト
 *
 * ─────────────────────────────────────────
 * 【仕組み】
 * 1. 公開台帳（Googleスプレッドシート）を CSV として読み込む
 * 2. 「公開フラグが TRUE」かつ「日付が今日以前」の行だけを対象にする
 * 3. コラムの行は、記事URL の Googleドキュメントを取得して本文を HTML に変換する
 * 4. column.html の
 *      <!-- ARTICLE_LIST_START --> 〜 <!-- ARTICLE_LIST_END -->
 *    の間を、記事一覧（開閉式）で丸ごと差し替える
 * 5. index.html の
 *      <!-- NEWS_LIST_START --> 〜 <!-- NEWS_LIST_END -->
 *    の間を、新着のお知らせ（コラム公開のお知らせ＋通常のお知らせ）で差し替える
 * 6. 記事内の画像は column-img/ フォルダに書き出す
 *
 * 途中でエラーが起きた場合は、どのファイルも書き換えずに終了します
 * （サイトが中途半端な状態で公開されることはありません）。
 *
 * 【公開台帳の列（1行目は見出し）】
 *   記事ID     半角英数字とハイフン。例）money-01　※コラムは必須。ページ内リンク先になります
 *   日付       例）2026/10/3　※未来の日付にすると、その日まで公開されません（予約公開）
 *   カテゴリ   お金と経営／生成AIと効率化／創業／補助金と助成金／その他／お知らせ
 *   タイトル   空欄なら、ドキュメント先頭の見出しを使います（「お知らせ」の行は必須）
 *   記事URL    Googleドキュメントの URL（「お知らせ」の行は、リンク先 URL。空欄でも可）
 *   公開フラグ TRUE の行だけ公開されます
 *   ※ これ以外の列（メモなど）は無視されます
 * ─────────────────────────────────────────
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

/* ========== 設定（変更するのは主にここ） ========== */

// 公開台帳の「ウェブに公開」CSV URL（GitHub の Secrets: SHEET_CSV_URL から渡されます）
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || '';

// トップページの「お知らせ・コラム」に表示する件数
const MAX_NEWS = 5;

// カテゴリ名 →（絞り込みボタン・色分け用の記号）
// カテゴリを増やすときは、ここに1行足し、column.html の絞り込みボタンと色（.cat-◯◯）も足します
const CATEGORIES = {
  'お金と経営': 'money',
  '生成AIと効率化': 'ai',
  '創業': 'startup',
  '補助金と助成金': 'subsidy',
  'その他': 'other',
};
// この名前のカテゴリは「記事のないお知らせ」として扱います（トップページにだけ表示）
const NEWS_CATEGORY = 'お知らせ';

// 各記事の末尾に入れる相談への案内
const CTA_HTML =
  '<div class="article-cta">\n' +
  '            この内容について相談したい方は <a href="contact.html">無料相談はこちら →</a>\n' +
  '          </div>';

// 本文に「ブロックパズル」が出てきて、和仁氏の名前が本文にない記事に自動で付ける出典表記
const SOURCE_NOTE_HTML =
  '<p class="source-note">※「お金のブロックパズル®」は和仁達也氏が考案した手法です。</p>';

/* ========== ここから下は仕組み本体 ========== */

const ROOT = path.join(__dirname, '..');
const COLUMN_HTML = path.join(ROOT, 'column.html');
const INDEX_HTML = path.join(ROOT, 'index.html');
const IMG_DIR_NAME = 'column-img';
const IMG_DIR = path.join(ROOT, IMG_DIR_NAME);

// 動作確認用：このフォルダを指定すると、ネットに接続せず
// 「ledger.csv」と「<ドキュメントID>.md」を読み込みます
const TEST_DIR = process.env.COLUMN_TEST_DIR || '';

const TOGGLE_SVG =
  '<svg viewBox="0 0 14 8"><path d="M1 1l6 6 6-6" stroke="#143354" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

async function main() {
  // ---- 1. 台帳を読む ----
  const csvText = await loadLedgerCsv();
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    throw new Error('公開台帳にデータがありません（見出し行しか読み取れませんでした）。台帳の「ウェブに公開」設定を確認してください。');
  }
  const col = mapHeader(rows[0]);
  const today = todayKeyJst();

  // ---- 2. 公開対象の行を選ぶ ----
  const items = [];
  const usedIds = new Set();
  let scheduled = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.some(cell => cell.trim() !== '')) continue; // 空行
    const rowNo = i + 1; // スプレッドシート上の行番号
    const get = key => (row[col[key]] || '').trim();

    if (!isTrue(get('flag'))) continue; // 公開フラグが TRUE 以外は下書き扱い

    const date = parseDate(get('date'));
    if (!date) {
      throw new Error(`台帳 ${rowNo} 行目：日付「${get('date')}」を読み取れません。「2026/10/3」の形で入力してください。`);
    }
    if (date.key > today) { scheduled++; continue; } // 予約公開（まだ日付が来ていない）

    const category = get('category');
    if (!category) {
      throw new Error(`台帳 ${rowNo} 行目：カテゴリが空です。`);
    }

    if (category === NEWS_CATEGORY) {
      const title = get('title');
      if (!title) throw new Error(`台帳 ${rowNo} 行目：お知らせの行はタイトルが必要です。`);
      items.push({ type: 'news', rowNo, date, title, link: get('url') });
      continue;
    }

    const id = get('id');
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(id)) {
      throw new Error(`台帳 ${rowNo} 行目：記事ID「${id}」が使えません。半角の英字で始め、英数字とハイフンだけにしてください（例：money-01）。`);
    }
    if (usedIds.has(id)) {
      throw new Error(`台帳 ${rowNo} 行目：記事ID「${id}」が重複しています。記事ごとに違うIDにしてください。`);
    }
    usedIds.add(id);

    const docId = extractDocId(get('url'));
    if (!docId) {
      throw new Error(`台帳 ${rowNo} 行目：記事URL から GoogleドキュメントのIDを読み取れません。ドキュメントのURLをそのまま貼り付けてください。`);
    }

    let slug = CATEGORIES[category];
    if (!slug) {
      console.warn(`【注意】台帳 ${rowNo} 行目：カテゴリ「${category}」は登録されていないため「その他」の絞り込みに入れます。`);
      slug = 'other';
    }

    items.push({ type: 'column', rowNo, date, id, docId, category, slug, title: get('title') });
  }

  // 新しい順（同じ日付なら、台帳で下にある行を上に）
  items.sort((a, b) => (b.date.key - a.date.key) || (b.rowNo - a.rowNo));

  // ---- 3. 各コラムの本文を取得して HTML に変換 ----
  const images = []; // { fileName, buffer }
  for (const item of items) {
    if (item.type !== 'column') continue;
    console.log(`記事を取得しています… ${item.id}（台帳 ${item.rowNo} 行目）`);
    const md = await loadDocMarkdown(item);
    const article = convertArticle(md, item.id);
    if (!item.title) item.title = article.docTitle;
    if (!item.title) {
      throw new Error(`台帳 ${item.rowNo} 行目：タイトルを決められません。台帳のタイトル欄に入力するか、ドキュメントの1行目を「見出し」にしてください。`);
    }
    item.bodyHtml = article.html;
    images.push(...article.images);
  }

  const columns = items.filter(it => it.type === 'column');

  // ---- 4. 差し替える HTML を組み立てる（ここまでファイルは書き換えない） ----
  const columnPage = replaceBetween(
    fs.readFileSync(COLUMN_HTML, 'utf-8'), 'column.html',
    '<!-- ARTICLE_LIST_START -->', '<!-- ARTICLE_LIST_END -->',
    columns.map(articleToHtml).join('\n\n'), '    '
  );
  const newsItems = items.slice(0, MAX_NEWS);
  const indexPage = replaceBetween(
    fs.readFileSync(INDEX_HTML, 'utf-8'), 'index.html',
    '<!-- NEWS_LIST_START -->', '<!-- NEWS_LIST_END -->',
    newsItems.length ? newsItems.map(newsToHtml).join('\n') : emptyNewsHtml(), '    '
  );

  // ---- 5. 書き出し ----
  fs.rmSync(IMG_DIR, { recursive: true, force: true });
  if (images.length) {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    for (const img of images) fs.writeFileSync(path.join(IMG_DIR, img.fileName), img.buffer);
  }
  fs.writeFileSync(COLUMN_HTML, columnPage, 'utf-8');
  fs.writeFileSync(INDEX_HTML, indexPage, 'utf-8');

  console.log('──────────────');
  console.log(`コラム ${columns.length} 件を column.html に反映しました。`);
  console.log(`お知らせ ${newsItems.length} 件を index.html に反映しました。`);
  if (images.length) console.log(`画像 ${images.length} 枚を ${IMG_DIR_NAME}/ に書き出しました。`);
  if (scheduled) console.log(`予約公開（日付がまだ先）の行が ${scheduled} 件あります。`);
}

/* ---------- 台帳・ドキュメントの読み込み ---------- */

async function loadLedgerCsv() {
  if (TEST_DIR) return fs.readFileSync(path.join(TEST_DIR, 'ledger.csv'), 'utf-8');
  if (!/^https?:\/\//.test(SHEET_CSV_URL)) {
    throw new Error('台帳の CSV URL が設定されていません。GitHub の Secrets に SHEET_CSV_URL を登録してください。');
  }
  console.log('公開台帳を取得しています…');
  const text = await fetchText(SHEET_CSV_URL);
  if (text === null || /^\s*<(!DOCTYPE|html)/i.test(text)) {
    throw new Error('公開台帳を CSV として取得できませんでした。スプレッドシートの「ファイル → 共有 → ウェブに公開」で、形式が「カンマ区切り形式（.csv）」になっているか確認してください。');
  }
  return text;
}

async function loadDocMarkdown(item) {
  if (TEST_DIR) return fs.readFileSync(path.join(TEST_DIR, item.docId + '.md'), 'utf-8');
  const url = `https://docs.google.com/document/d/${item.docId}/export?format=md`;
  const text = await fetchText(url);
  // 共有されていないドキュメントは、本文の代わりにログイン画面（HTML）が返ってくる
  if (text === null || /^\s*<(!DOCTYPE|html)/i.test(text)) {
    throw new Error(
      `台帳 ${item.rowNo} 行目（記事ID：${item.id}）のドキュメントを取得できません。\n` +
      '  → ドキュメント（または入っているフォルダ）の共有設定が「リンクを知っている全員：閲覧者」になっているか確認してください。'
    );
  }
  return text;
}

// 取得に失敗したら少し待って再試行（一時的な通信エラー対策）。だめなら null
async function fetchText(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) return await res.text();
      if (res.status < 500 && res.status !== 429) return null; // 権限なし・URL違いなどは再試行しても同じ
    } catch (e) { /* 通信エラー → 再試行 */ }
    await new Promise(r => setTimeout(r, attempt * 3000));
  }
  return null;
}

/* ---------- 記事本文の変換（Googleドキュメントの Markdown → サイト用 HTML） ---------- */

function convertArticle(mdSource, id) {
  let md = String(mdSource).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const images = [];

  // (1) 画像：ドキュメントは画像を文末に「[image1]: <data:image/png;base64,...>」の形で持っている
  const defs = {};
  md = md.replace(/^\[([^\]\n]+)\]:\s*<?data:image\/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+\/=]+)>?[ \t]*$/gm,
    (_, name, type, data) => { defs[name] = { type, data }; return ''; });
  const saveImage = (type, data) => {
    const ext = { jpeg: 'jpg', 'svg+xml': 'svg' }[type.toLowerCase()] || type.toLowerCase();
    const fileName = `${id}-${images.length + 1}.${ext}`;
    images.push({ fileName, buffer: Buffer.from(data, 'base64') });
    return `${IMG_DIR_NAME}/${fileName}`;
  };
  md = md.replace(/!\[([^\]\n]*)\]\[([^\]\n]+)\]/g, (whole, alt, name) => {
    const def = defs[name];
    return def ? `<img src="${saveImage(def.type, def.data)}" alt="${escapeHtml(alt)}">` : whole;
  });
  md = md.replace(/!\[([^\]\n]*)\]\(data:image\/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+\/=]+)\)/g,
    (_, alt, type, data) => `<img src="${saveImage(type, data)}" alt="${escapeHtml(alt)}">`);

  // (2) 先頭の見出し＝記事タイトル。開閉ボタンに表示するので、本文からは外す
  let docTitle = '';
  md = md.replace(/^\s*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*(\n|$)/, (_, text) => {
    docTitle = unescapeMd(text.replace(/\*\*|__/g, '')).trim();
    return '';
  });

  // (3) 区切り線（---）は使わない。見出しで区切りが分かるため
  md = md.replace(/^[ \t]*([-*_])[ \t]*(\1[ \t]*){2,}$/gm, '');

  // (4) 太字・斜体を先に HTML にしておく
  //     （標準の Markdown は「」や句読点に接した ** を太字と認識しないことがあるため）
  md = md.replace(/\*{4}([ \t]*\n[ \t]*|[ \t]+)\*{2}/g, '**$1'); // 「太字の直後に、改行だけの太字」が続く書き出しのクセを直す
  md = md.replace(/(?<!\\)\*\*(?=\S)((?:(?!\n[ \t]*\n)[\s\S])+?)(?<=[^\s\\])\*\*/g, '<strong>$1</strong>');
  md = md.replace(/(?<![\\*])\*(?=[^\s*])((?:(?!\n[ \t]*\n)[^*])+?)(?<=[^\s\\*])\*(?!\*)/g, '<em>$1</em>');

  // (5) Markdown → HTML
  let html = marked.parse(md, { gfm: true, breaks: false });

  // (6) サイトのデザインに合わせて整える
  // 見出しは h4（小見出しは h5）に統一。見出し全体にかかった太字指定は不要なので外す
  html = normalizeHeadings(html);
  html = html.replace(/<(h[45])><strong>([\s\S]*?)<\/strong><\/\1>/g, '<$1>$2</$1>');
  // 表：1行目（見出し行）が空なら、2行目を見出し行に繰り上げる。横にはみ出す場合は横スクロール
  html = html.replace(/<thead>([\s\S]*?)<\/thead>\s*<tbody>\s*(<tr>[\s\S]*?<\/tr>)/g, (whole, head, firstRow) => {
    if (head.replace(/<[^>]+>/g, '').trim() !== '') return whole;
    return '<thead>\n' + firstRow.replace(/<(\/?)td/g, '<$1th') + '\n</thead>\n<tbody>';
  });
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  // 外部サイトへのリンクは別タブで開く
  html = html.replace(/<a href="(https?:\/\/[^"]+)"/g, '<a href="$1" target="_blank" rel="noopener"');

  // 余分な空白の掃除
  html = html.replace(/[ \t]+<\/li>/g, '</li>').replace(/<br>[ \t]+/g, '<br>').trim();
  if (html.includes('ブロックパズル') && !html.includes('和仁')) html += '\n' + SOURCE_NOTE_HTML;

  return { docTitle, html, images };
}

// 見出しの段階をそろえる：ドキュメントの見出し1〜3 → h4、見出し4〜6 → h5
function normalizeHeadings(html) {
  return html.replace(/<(\/?)h([1-6])>/g, (_, slash, level) => `<${slash}h${Number(level) <= 3 ? 4 : 5}>`);
}

/* ---------- HTML の組み立て ---------- */

function articleToHtml(item) {
  const body = item.bodyHtml.split('\n').map(line => (line ? '          ' + line : line)).join('\n');
  return (
    `    <!-- ${item.id} -->\n` +
    `    <article class="article" id="${item.id}" data-category="${item.slug}">\n` +
    '      <button class="article-head" aria-expanded="false">\n' +
    '        <span class="article-meta">\n' +
    `          <span class="article-date">${formatDatePadded(item.date)}</span>\n` +
    `          <span class="cat-tag cat-${item.slug}">${escapeHtml(item.category)}</span>\n` +
    '        </span>\n' +
    `        <span class="article-title">${escapeHtml(item.title)}</span>\n` +
    `        <span class="article-toggle" aria-hidden="true">${TOGGLE_SVG}</span>\n` +
    '      </button>\n' +
    '      <div class="article-body">\n' +
    '        <div class="article-body-inner">\n' +
    body + '\n' +
    '          ' + CTA_HTML + '\n' +
    '        </div>\n' +
    '      </div>\n' +
    '    </article>'
  );
}

function newsToHtml(item) {
  const date = formatDatePlain(item.date);
  if (item.type === 'column') {
    return (
      '      <li class="news-item">\n' +
      `        <time>${date}</time>\n` +
      '        <span class="tag tag-column">コラム</span>\n' +
      `        <a href="column.html#${item.id}"><span class="title">コラム「${escapeHtml(item.title)}」を公開しました</span></a>\n` +
      '      </li>'
    );
  }
  const title = `<span class="title">${escapeHtml(item.title)}</span>`;
  return (
    '      <li class="news-item">\n' +
    `        <time>${date}</time>\n` +
    '        <span class="tag tag-news">お知らせ</span>\n' +
    `        ${item.link ? `<a href="${escapeHtml(item.link)}">${title}</a>` : title}\n` +
    '      </li>'
  );
}

function emptyNewsHtml() {
  return (
    '      <li class="news-item">\n' +
    '        <span class="title">現在、お知らせはありません。</span>\n' +
    '      </li>'
  );
}

function replaceBetween(original, fileName, startMark, endMark, inner, indent) {
  const startIdx = original.indexOf(startMark);
  const endIdx = original.indexOf(endMark);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`${fileName} に目印のコメント（${startMark} と ${endMark}）が見つかりません。この2行は消さないでください。`);
  }
  return original.slice(0, startIdx + startMark.length) + '\n' + inner + '\n' + indent + original.slice(endIdx);
}

/* ---------- 小さな道具 ---------- */

function mapHeader(headerRow) {
  const names = headerRow.map(h => h.replace(/^﻿/, '').trim());
  const find = (...candidates) => names.findIndex(n => candidates.includes(n));
  const col = {
    id: find('記事ID'),
    date: find('日付'),
    category: find('カテゴリ', 'タグ'),
    title: find('タイトル'),
    url: find('記事URL', 'リンクURL'),
    flag: find('公開フラグ'),
  };
  const labels = { id: '記事ID', date: '日付', category: 'カテゴリ', title: 'タイトル', url: '記事URL', flag: '公開フラグ' };
  const missing = Object.keys(col).filter(k => col[k] === -1).map(k => labels[k]);
  if (missing.length) {
    throw new Error(`公開台帳の1行目に、見出し「${missing.join('」「')}」が見つかりません。見出しの名前は変えないでください。`);
  }
  return col;
}

function isTrue(value) {
  return ['TRUE', '1', 'YES', '公開', '○', '◯'].includes(String(value).trim().toUpperCase());
}

function extractDocId(url) {
  const m = String(url).match(/\/document\/d\/([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : '';
}

// 「2026/10/3」「2026-10-03」「2026年10月3日」「10/3/2026」を読み取る
function parseDate(value) {
  const text = String(value).trim();
  let y, mo, d;
  let m = text.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) {
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  } else {
    // スプレッドシートの地域設定が英語（アメリカ）のときの「月/日/年」表記
    m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    mo = Number(m[1]); d = Number(m[2]); y = Number(m[3]);
  }
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return { y, mo, d, key: y * 10000 + mo * 100 + d };
}

// 日本時間での「今日」
function todayKeyJst() {
  const override = parseDate(process.env.COLUMN_TODAY || ''); // 動作確認用
  if (override) return override.key;
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
}

function formatDatePlain(date) { return `${date.y}/${date.mo}/${date.d}`; }
function formatDatePadded(date) {
  return `${date.y}/${String(date.mo).padStart(2, '0')}/${String(date.d).padStart(2, '0')}`;
}

function unescapeMd(text) {
  return String(text).replace(/\\([!-\/:-@\[-`{-~])/g, '$1');
}

// CSV の読み取り（ダブルクォート・カンマ・セル内改行に対応）
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows; // 行番号がずれないよう、空行も残す
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { convertArticle, parseCsv, parseDate };

if (require.main === module) {
  main().catch(err => {
    console.error('\n【エラー】サイトは更新していません。');
    console.error(err.message || err);
    process.exit(1);
  });
}
