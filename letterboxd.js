const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const axios = require('axios');

puppeteer.use(StealthPlugin());

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

function envInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DEFAULT_HTTP_TIMEOUT_MS = envInt(process.env.LETTERBOXD_HTTP_TIMEOUT_MS, 20000);
const DEFAULT_NAV_TIMEOUT_MS = envInt(process.env.LETTERBOXD_NAV_TIMEOUT_MS, 30000);
const DEFAULT_TEXT_LIMIT = envInt(process.env.LETTERBOXD_MAX_TEXT_LENGTH, 1200);

function normalizeLimit(limit) {
  if (limit === undefined || limit === null) return undefined;
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value) return [value];
  return [];
}

function cleanJsonLd(raw) {
  if (!raw) return null;
  const cleaned = raw
    .replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\//, '')
    .replace(/\/\*\s*\]\]>\s*\*\/\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

class LetterboxdClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://letterboxd.com';
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.httpTimeoutMs = options.httpTimeoutMs || DEFAULT_HTTP_TIMEOUT_MS;
    this.navTimeoutMs = options.navTimeoutMs || DEFAULT_NAV_TIMEOUT_MS;
    this.maxTextLength = options.maxTextLength || DEFAULT_TEXT_LIMIT;

    this.browser = null;
    this.browserPromise = null;
    this.cookies = [];
    this.cookieHeader = '';
    this.username = null;
    this.isLoggedIn = false;
    this.loginPromise = null;
    this.queue = Promise.resolve();
  }

  async init() {
    await this._ensureBrowser();
  }

  async _ensureBrowser() {
    if (this.browser) return this.browser;
    if (!this.browserPromise) {
      const headlessSetting = process.env.LETTERBOXD_HEADLESS;
      const headless = headlessSetting === undefined ? true : headlessSetting !== 'false';
      this.browserPromise = puppeteer
        .launch({
          headless,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        })
        .then((browser) => {
          this.browser = browser;
          return browser;
        })
        .catch((error) => {
          this.browserPromise = null;
          throw error;
        });
    }
    return this.browserPromise;
  }

  _runExclusive(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async _runBrowserTask(task) {
    return this._runExclusive(async () => {
      const browser = await this._ensureBrowser();
      const page = await browser.newPage();
      await page.setUserAgent(this.userAgent);
      page.setDefaultNavigationTimeout(this.navTimeoutMs);
      page.setDefaultTimeout(this.navTimeoutMs);
      if (this.cookies.length) {
        await page.setCookie(...this.cookies);
      }
      try {
        return await task(page);
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  async _captureCookies(page) {
    const cookies = await page.cookies();
    this.cookies = cookies;
    this.cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    this.isLoggedIn = true;
  }

  async login(username, password) {
    this.username = username;
    return this._runBrowserTask(async (page) => {
      await page.goto(`${this.baseUrl}/signin/`, {
        waitUntil: 'domcontentloaded',
        timeout: this.navTimeoutMs,
      });
      await page.type('#username', username);
      await page.type('#password', password);
      await Promise.all([
        page.click('.button.-primary.button-signin'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: this.navTimeoutMs }),
      ]);

      const error = await page.$('.message.-error');
      if (error) {
        const text = await page.evaluate((el) => el.textContent, error);
        throw new Error(`Login failed: ${text.trim()}`);
      }

      await this._captureCookies(page);
      return true;
    });
  }

  async ensureLoggedIn() {
    if (this.isLoggedIn) return;
    if (this.loginPromise) return this.loginPromise;
    const username = process.env.LETTERBOXD_USERNAME;
    const password = process.env.LETTERBOXD_PASSWORD;
    if (!username || !password) {
      throw new Error('Missing LETTERBOXD_USERNAME or LETTERBOXD_PASSWORD.');
    }
    this.loginPromise = this.login(username, password).finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  _needsBrowser(html) {
    if (!html || typeof html !== 'string') return true;
    const lowered = html.toLowerCase();
    return (
      lowered.includes('enable javascript') ||
      lowered.includes('are you a robot') ||
      lowered.includes('captcha') ||
      lowered.includes('cloudflare')
    );
  }

  async _httpGet(url) {
    const headers = {
      'User-Agent': this.userAgent,
      Accept: 'text/html,application/xhtml+xml',
    };
    if (this.cookieHeader) {
      headers.Cookie = this.cookieHeader;
    }
    return axios.get(url, {
      headers,
      timeout: this.httpTimeoutMs,
      validateStatus: () => true,
    });
  }

  async _fetchHtmlWithBrowser(url) {
    return this._runBrowserTask(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.navTimeoutMs });
      return await page.content();
    });
  }

  async fetchHtml(url) {
    try {
      const response = await this._httpGet(url);
      if (response.status >= 200 && response.status < 300) {
        if (!this._needsBrowser(response.data)) {
          return response.data;
        }
        return this._fetchHtmlWithBrowser(url);
      }
      if (response.status === 403 || response.status === 429) {
        return this._fetchHtmlWithBrowser(url);
      }
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`Request failed with status ${response.status}`);
      }
    } catch {
      return this._fetchHtmlWithBrowser(url);
    }
    return this._fetchHtmlWithBrowser(url);
  }

  async getPageSource(url) {
    return this.fetchHtml(url);
  }

  resolveCursor(cursor, fallbackUrl) {
    if (!cursor) return fallbackUrl;
    if (cursor.startsWith('http://') || cursor.startsWith('https://')) return cursor;
    if (cursor.startsWith('/')) return `${this.baseUrl}${cursor}`;
    return `${this.baseUrl}/${cursor.replace(/^\/+/, '')}`;
  }

  _truncateText(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return { text: '', truncated: false };
    if (trimmed.length <= this.maxTextLength) {
      return { text: trimmed, truncated: false };
    }
    return { text: `${trimmed.slice(0, this.maxTextLength)}...`, truncated: true };
  }

  _extractPosterItems($) {
    const items = [];
    $('.poster-grid .griditem, .poster-container, .poster-list .posteritem').each((i, el) => {
      const imgAlt = $(el).find('img').attr('alt') || '';
      const title = imgAlt.replace(/^Poster for /, '').trim();
      const slug =
        $(el).find('[data-item-slug]').attr('data-item-slug') ||
        $(el).find('[data-film-slug]').attr('data-film-slug') ||
        $(el).find('.poster').attr('data-film-slug') ||
        $(el).find('a').attr('href')?.split('/').filter(Boolean).pop();
      if (title && slug) {
        items.push({ title, slug });
      }
    });
    return items;
  }

  async fetchPage(url, scraperFunc, limit) {
    const html = await this.fetchHtml(url);
    const $ = cheerio.load(html);
    let items = scraperFunc($);
    const normalizedLimit = normalizeLimit(limit);
    if (normalizedLimit !== undefined) {
      items = items.slice(0, normalizedLimit);
    }
    const nextLink = $('.paginate-next a, .next a').first().attr('href');
    const nextCursor = nextLink ? new URL(nextLink, url).toString() : null;
    return { items, nextCursor };
  }

  async search(query, type = 'films', options = {}) {
    const url = this.resolveCursor(
      options.cursor,
      `${this.baseUrl}/search/${type}/${encodeURIComponent(query)}/`
    );
    const { items, nextCursor } = await this.fetchPage(
      url,
      ($) => {
        const results = [];
        $('.results li').each((i, el) => {
          const titleElement = $(el).find('.film-title-wrapper a, .name a').first();
          const title = titleElement.text().trim() || $(el).find('.name').text().trim();
          const link = titleElement.attr('href') || $(el).find('a').attr('href');
          if (title && link) {
            results.push({
              title,
              url: `${this.baseUrl}${link}`,
              slug: link.split('/').filter(Boolean).pop(),
            });
          }
        });
        return results;
      },
      options.limit
    );
    return { items, nextCursor };
  }

  async getFilm(slug) {
    const url = `${this.baseUrl}/film/${slug}/`;
    const html = await this.fetchHtml(url);
    const $ = cheerio.load(html);

    let filmData = {};
    const jsonLdEntries = $('script[type="application/ld+json"]')
      .map((i, el) => cleanJsonLd($(el).html()))
      .get()
      .filter(Boolean);

    for (const entry of jsonLdEntries) {
      const items = Array.isArray(entry) ? entry : entry['@graph'] ? entry['@graph'] : [entry];
      for (const item of items) {
        if (!item || !item['@type']) continue;
        if (item['@type'] === 'Movie' || item['@type'] === 'Film') {
          filmData = item;
          break;
        }
      }
      if (filmData['@type']) break;
    }

    const directors = toArray(filmData.director)
      .map((director) => director.name)
      .filter(Boolean)
      .join(', ');

    const releasedEvent = toArray(filmData.releasedEvent)[0];
    const year =
      (releasedEvent && releasedEvent.startDate) ||
      filmData.datePublished ||
      $('.releaseyear a').text().trim();

    const genres = toArray(filmData.genre).filter(Boolean);
    const synopsisRaw =
      $('.truncate p').text().trim() ||
      $('.review-body-text').first().text().trim() ||
      $('.body-text').first().text().trim();
    const synopsis = this._truncateText(synopsisRaw);

    const rating =
      (filmData.aggregateRating && filmData.aggregateRating.ratingValue) ||
      $('.average-rating a, .average-rating').first().text().trim();

    return {
      title: filmData.name || $('.headline-1').text().trim() || $('h1').first().text().trim(),
      year,
      director: directors || $('.director a').map((i, el) => $(el).text().trim()).get().join(', '),
      synopsis: synopsis.text,
      synopsis_truncated: synopsis.truncated,
      rating,
      genre: genres.length ? genres.join(', ') : '',
      url,
    };
  }

  async getList(username, listSlug, options = {}) {
    const url = this.resolveCursor(options.cursor, `${this.baseUrl}/${username}/list/${listSlug}/`);
    return this.fetchPage(url, ($) => this._extractPosterItems($), options.limit);
  }

  async getReview(username, filmSlug) {
    const url = `${this.baseUrl}/${username}/film/${filmSlug}/`;
    const html = await this.fetchHtml(url);
    const $ = cheerio.load(html);
    const reviewRaw = $('.review .body-text, .review-body, .body-text').first().text().trim();
    const reviewText = this._truncateText(reviewRaw);
    return { username, filmSlug, reviewText: reviewText.text, truncated: reviewText.truncated };
  }

  async getMember(username) {
    const url = `${this.baseUrl}/${username}/`;
    const html = await this.fetchHtml(url);
    const $ = cheerio.load(html);

    const bioRaw = $('.bio p').text().trim();
    const bio = this._truncateText(bioRaw);
    const stats = {};
    $('.profile-stats a').each((i, el) => {
      const label = $(el).find('.definition').text().trim();
      const value = $(el).find('.value').text().trim();
      if (label) stats[label] = value;
    });

    const displayName = $('h1').first().text().trim();
    return { username, displayName, bio: bio.text, bio_truncated: bio.truncated, stats, url };
  }

  async getMemberWatchlist(username, options = {}) {
    const url = this.resolveCursor(options.cursor, `${this.baseUrl}/${username}/watchlist/`);
    return this.fetchPage(url, ($) => this._extractPosterItems($), options.limit);
  }

  async getMemberFilms(username, options = {}) {
    const url = this.resolveCursor(options.cursor, `${this.baseUrl}/${username}/films/`);
    return this.fetchPage(url, ($) => this._extractPosterItems($), options.limit);
  }

  async getMemberRatings(username, options = {}) {
    const url = this.resolveCursor(options.cursor, `${this.baseUrl}/${username}/films/ratings/`);
    return this.fetchPage(
      url,
      ($) => {
        const items = [];
        $('.poster-grid .griditem, .poster-container, .poster-list .posteritem').each((i, el) => {
          const imgAlt = $(el).find('img').attr('alt') || '';
          const title = imgAlt.replace(/^Poster for /, '').trim();
          const slug =
            $(el).find('[data-item-slug]').attr('data-item-slug') ||
            $(el).find('[data-film-slug]').attr('data-film-slug') ||
            $(el).find('.poster').attr('data-film-slug') ||
            $(el).find('a').attr('href')?.split('/').filter(Boolean).pop();
          const rating = $(el).find('.poster-viewingdata .rating').text().trim();
          if (title && slug) {
            items.push({ title, slug, rating });
          }
        });
        return items;
      },
      options.limit
    );
  }

  async getMemberReviews(username, options = {}) {
    const url = this.resolveCursor(options.cursor, `${this.baseUrl}/${username}/films/reviews/`);
    return this.fetchPage(
      url,
      ($) => {
        const items = [];
        $('.listitem, li.listitem').each((i, el) => {
          const title = $(el).find('.name a').text().trim();
          const slug =
            $(el).find('.react-component').attr('data-item-slug') ||
            $(el).find('.name a').attr('href')?.split('/').filter(Boolean).pop();
          const rating = $(el).find('.rating').text().trim();
          const summaryRaw = $(el).find('.body-text').text().trim();
          const summary = this._truncateText(summaryRaw);
          if (title && slug) {
            items.push({ title, slug, rating, summary: summary.text });
          }
        });
        return items;
      },
      options.limit
    );
  }

  async getMemberDiary(username, options = {}) {
    const url = this.resolveCursor(options.cursor, `${this.baseUrl}/${username}/diary/`);
    return this.fetchPage(
      url,
      ($) => {
        const items = [];
        $('.diary-entry-row').each((i, el) => {
          const day = $(el).find('.td-calendar .day').text().trim();
          const month = $(el).find('.td-calendar .month').text().trim();
          const date = [day, month].filter(Boolean).join(' ');
          const title = $(el).find('.td-film-details h3 a').text().trim();
          const slug = $(el)
            .find('.td-film-details h3 a')
            .attr('href')
            ?.split('/')
            .filter(Boolean)
            .pop();
          const rating = $(el).find('.td-rating .rating').text().trim();
          if (title) {
            items.push({ date, title, slug: slug || '', rating });
          }
        });
        return items;
      },
      options.limit
    );
  }

  async getCurrentUser() {
    return { username: this.username, loggedIn: this.isLoggedIn };
  }

  async rateFilm(slug, rating) {
    await this.ensureLoggedIn();
    return this._runBrowserTask(async (page) => {
      await page.goto(`${this.baseUrl}/film/${slug}/`, {
        waitUntil: 'domcontentloaded',
        timeout: this.navTimeoutMs,
      });
      await page.waitForSelector('.rate-it', { timeout: this.navTimeoutMs });

      const selector = `.rate-it .stars .star-${rating}`;
      await page.click(selector);

      const confirmed = await page
        .waitForFunction(
          (value) => {
            const rateIt = document.querySelector('.rate-it');
            if (!rateIt) return false;
            if (rateIt.classList.contains('rated')) return true;
            const dataRating = rateIt.getAttribute('data-rating');
            if (dataRating && Number(dataRating) === value) return true;
            const active = rateIt.querySelector(`.star-${value}.rated, .star-${value}.on`);
            return !!active;
          },
          { timeout: this.navTimeoutMs },
          rating
        )
        .then(() => true)
        .catch(() => false);

      if (!confirmed) {
        throw new Error('Rating did not appear to apply.');
      }
      return true;
    });
  }

  async addToWatchlist(slug) {
    await this.ensureLoggedIn();
    return this._runBrowserTask(async (page) => {
      await page.goto(`${this.baseUrl}/film/${slug}/`, {
        waitUntil: 'domcontentloaded',
        timeout: this.navTimeoutMs,
      });
      await page.waitForSelector('.watchlist-tgl', { timeout: this.navTimeoutMs });

      const isOn = await page.evaluate(() => {
        const btn = document.querySelector('.watchlist-tgl');
        if (!btn) return false;
        return (
          btn.classList.contains('on') ||
          btn.classList.contains('active') ||
          btn.getAttribute('data-state') === 'on'
        );
      });

      if (!isOn) {
        await page.click('.watchlist-tgl');
      }

      const confirmed = await page
        .waitForFunction(() => {
          const btn = document.querySelector('.watchlist-tgl');
          if (!btn) return false;
          return (
            btn.classList.contains('on') ||
            btn.classList.contains('active') ||
            btn.getAttribute('data-state') === 'on'
          );
        })
        .then(() => true)
        .catch(() => false);

      if (!confirmed) {
        throw new Error('Watchlist toggle did not confirm.');
      }
      return true;
    });
  }

  async writeReview(slug, reviewText, rating, containsSpoilers = false) {
    await this.ensureLoggedIn();
    return this._runBrowserTask(async (page) => {
      await page.goto(`${this.baseUrl}/film/${slug}/`, {
        waitUntil: 'domcontentloaded',
        timeout: this.navTimeoutMs,
      });
      await page.waitForSelector('.action-viewing, .action-log', { timeout: this.navTimeoutMs });
      await page.click('.action-viewing, .action-log');

      await page.waitForSelector('#field-diary-review', { timeout: this.navTimeoutMs });
      await page.type('#field-diary-review', reviewText);

      if (rating) {
        const selector = `.rate-it .stars .star-${rating}`;
        await page.click(selector);
      }

      if (containsSpoilers) {
        await page.click('#field-any-spoilers');
      }

      await Promise.all([
        page.click('#diary-entry-submit'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: this.navTimeoutMs }).catch(() => null),
      ]);

      const error = await page.$('.message.-error, .field-errors');
      if (error) {
        const text = await page.evaluate((el) => el.textContent, error);
        throw new Error(`Review submission failed: ${text.trim()}`);
      }
      return true;
    });
  }

  async addToList(slug, listSlug) {
    await this.ensureLoggedIn();
    return this._runBrowserTask(async (page) => {
      await page.goto(`${this.baseUrl}/film/${slug}/`, {
        waitUntil: 'domcontentloaded',
        timeout: this.navTimeoutMs,
      });
      await page.waitForSelector('.add-to-list, .action-add-to-list', { timeout: this.navTimeoutMs });
      await page.click('.add-to-list, .action-add-to-list');

      await page.waitForSelector('.list-select-item', { timeout: this.navTimeoutMs });
      const listFound = await page.evaluate((targetSlug) => {
        const items = document.querySelectorAll('.list-select-item');
        for (const item of items) {
          const link = item.querySelector('a');
          if (link && link.href.includes(targetSlug)) {
            const checkbox = item.querySelector('input[type="checkbox"]');
            if (checkbox) {
              checkbox.click();
            } else {
              item.click();
            }
            return true;
          }
        }
        return false;
      }, listSlug);

      if (!listFound) {
        throw new Error(`List not found: ${listSlug}`);
      }

      const confirmed = await page
        .waitForFunction(
          (targetSlug) => {
            const items = document.querySelectorAll('.list-select-item');
            for (const item of items) {
              const link = item.querySelector('a');
              if (link && link.href.includes(targetSlug)) {
                const checkbox = item.querySelector('input[type="checkbox"]');
                return (
                  item.classList.contains('selected') ||
                  item.classList.contains('checked') ||
                  (checkbox && checkbox.checked)
                );
              }
            }
            return false;
          },
          { timeout: this.navTimeoutMs },
          listSlug
        )
        .then(() => true)
        .catch(() => false);

      if (!confirmed) {
        throw new Error(`List selection did not confirm for: ${listSlug}`);
      }
      return true;
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.browserPromise = null;
    }
  }
}

module.exports = LetterboxdClient;
