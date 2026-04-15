// Mantle Twitter Ambient — v2 Bookmarklet (window.open 方案)
// --------------------------------------------------------
// v1 用 fetch() 被 x.com 的 CSP 拦住（Failed to fetch）。
// v2 改用 window.open 导航到本地 Mantle 的 GET 端点，浏览器 navigation
// 不受 CSP / CORS / Mixed Content / Private Network Access 约束。
// 代价：每次 mark 会弹一个小窗口，自动 1.5s 后关闭。

(function () {
  const MANTLE_TOKEN = '2bfae394-4414-4dcd-923b-2b05217de0d0';
  const MANTLE_URL = 'http://127.0.0.1:19816/bookmarks/ingest-via-url';

  // 从 URL 抽 tweetId
  const m = window.location.href.match(/status\/(\d+)/);
  if (!m) {
    alert('Mantle: 当前页面不是推文详情页');
    return;
  }
  const tweetId = m[1];

  // 找第一个 article
  const article = document.querySelector('article[data-testid="tweet"], article');
  if (!article) {
    alert('Mantle: 找不到推文内容 DOM');
    return;
  }

  // 提取文本
  const textEl = article.querySelector('[data-testid="tweetText"]');
  const text = textEl ? textEl.innerText : article.innerText.split('\n').slice(0, 3).join(' ');

  // 提取作者 handle
  let author = '';
  const userLinks = article.querySelectorAll('a[href^="/"]');
  for (const a of userLinks) {
    const href = a.getAttribute('href') || '';
    const h = href.match(/^\/([A-Za-z0-9_]+)(\/|$)/);
    if (h && !['home', 'explore', 'notifications', 'messages', 'i', 'search'].includes(h[1].toLowerCase())) {
      author = '@' + h[1];
      break;
    }
  }
  if (!author) author = '@unknown';

  // URL 长度限制 ~2KB，text 硬截到 1500 字符防超
  const params = new URLSearchParams({
    token: MANTLE_TOKEN,
    tweetId: tweetId,
    url: window.location.href,
    author: author,
    text: text.slice(0, 1500),
  });

  // 小窗口打开，Mantle 返回的 HTML 会 setTimeout window.close()
  const target = MANTLE_URL + '?' + params.toString();
  window.open(target, 'mantle-ingest', 'width=420,height=220');
})();
