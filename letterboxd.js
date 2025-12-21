const axios = require('axios');
const cheerio = require('cheerio');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

function envInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DEFAULT_HTTP_TIMEOUT_MS = envInt(process.env.LETTERBOXD_HTTP_TIMEOUT_MS, 20000);
const DEFAULT_TEXT_LIMIT = envInt(process.env.LETTERBOXD_MAX_TEXT_LENGTH, 0);
const MAX_REDIRECTS = envInt(process.env.LETTERBOXD_MAX_REDIRECTS, 5);

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
    this.maxTextLength = options.maxTextLength || DEFAULT_TEXT_LIMIT;
    this.loginForReads =
      typeof options.loginForReads === 'boolean'
        ? options.loginForReads
        : process.env.LETTERBOXD_LOGIN_FOR_READS === 'true';

    this.cookies = {};
    this.cookieHeader = '';
    this.username = null;
    this.isLoggedIn = false;
    this.loginPromise = null;
  }

  async init() {
    return;
  }

  _storeCookies(setCookieHeaders) {
    if (!setCookieHeaders) return;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const header of headers) {
      const pair = header.split(';')[0];
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!name) continue;
      if (value) {
        this.cookies[name] = value;
      } else {
        delete this.cookies[name];
      }
    }
    this.cookieHeader = Object.entries(this.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  async _request(method, url, options = {}) {
    let currentUrl = url;
    let currentMethod = method;
    let currentData = options.data;
    let redirects = 0;

    while (redirects <= MAX_REDIRECTS) {
      const headers = {
        'User-Agent': this.userAgent,
        Accept: 'text/html,application/xhtml+xml',
        ...(options.headers || {}),
      };
      if (this.cookieHeader) {
        headers.Cookie = this.cookieHeader;
      }

      const response = await axios({
        method: currentMethod,
        url: currentUrl,
        data: currentData,
        headers,
        timeout: this.httpTimeoutMs,
        maxRedirects: 0,
        validateStatus: () => true,
      });

      this._storeCookies(response.headers['set-cookie']);

      const status = response.status;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        const nextUrl = new URL(location, currentUrl).toString();
        if (status === 303 || (currentMethod !== 'GET' && status !== 307 && status !== 308)) {
          currentMethod = 'GET';
          currentData = undefined;
        }
        currentUrl = nextUrl;
        redirects += 1;
        continue;
      }

      return response;
    }

    throw new Error('Too many redirects.');
  }

  async fetchHtml(url, options = {}) {
    if (this.loginForReads && !options.skipLogin && !this.isLoggedIn) {
      await this.ensureLoggedIn();
    }
    const response = await this._request('GET', url);
    if (response.status >= 400) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    if (typeof response.data === 'string') return response.data;
    return JSON.stringify(response.data || '');
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
    if (this.maxTextLength <= 0) {
      return { text: trimmed, truncated: false };
    }
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

  async _getSigninForm() {
    const html = await this.fetchHtml(`${this.baseUrl}/signin/`, { skipLogin: true });
    const $ = cheerio.load(html);
    let form = $('form').filter((i, el) => $(el).find('input[name="username"], #username').length > 0).first();
    if (!form.length) {
      form = $('form').first();
    }
    const action = form.attr('action') || '/signin/';
    const fields = {};
    form.find('input').each((i, el) => {
      const name = $(el).attr('name');
      if (!name) return;
      fields[name] = $(el).attr('value') || '';
    });
    return { action: new URL(action, this.baseUrl).toString(), fields };
  }

  async login(username, password) {
    this.username = username;
    const { action, fields } = await this._getSigninForm();
    const payload = {
      ...fields,
      username,
      password,
    };

    const form = new URLSearchParams();
    Object.entries(payload).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        form.append(key, String(value));
      }
    });

    const response = await this._request('POST', action, {
      data: form.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const html = typeof response.data === 'string' ? response.data : '';
    const $ = cheerio.load(html);
    const error = $('.message.-error').text().trim();
    if (error) {
      throw new Error(`Login failed: ${error}`);
    }

    if (!this.cookieHeader) {
      throw new Error('Login failed: no session cookie received.');
    }

    this.isLoggedIn = true;
    return true;
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
        $('.diary-entry-row, tr.diary-entry-row, table#diary-table tbody tr').each((i, el) => {
          const row = $(el);
          const titleLink = row
            .find('.td-film-details h3 a, .td-film-details a, a[href*="/film/"]')
            .first();
          const title = titleLink.text().trim();
          if (!title) return;

          const slug =
            titleLink
              .attr('href')
              ?.split('/')
              .filter(Boolean)
              .pop() ||
            row.attr('data-film-slug') ||
            row.find('[data-film-slug]').attr('data-film-slug') ||
            '';

          const day = row.find('.td-calendar .day, .calendar-day, .day').first().text().trim();
          const month = row.find('.td-calendar .month, .calendar-month, .month').first().text().trim();
          let date = [day, month].filter(Boolean).join(' ');
          if (!date) {
            const dateTime = row.find('time').attr('datetime');
            if (dateTime) {
              date = dateTime.split('T')[0];
            }
          }

          const rating = row.find('.td-rating .rating, .rating').first().text().trim();
          items.push({ date, title, slug, rating });
        });
        return items;
      },
      options.limit
    );
  }

  async getCurrentUser() {
    return { username: this.username, loggedIn: this.isLoggedIn };
  }

  _ensureActionsEnabled() {
    throw new Error(
      'Write actions are disabled in HTTP-only mode. This deployment does not use a browser.'
    );
  }

  async rateFilm() {
    this._ensureActionsEnabled();
  }

  async addToWatchlist() {
    this._ensureActionsEnabled();
  }

  async writeReview() {
    this._ensureActionsEnabled();
  }

  async addToList() {
    this._ensureActionsEnabled();
  }

  async close() {
    return;
  }
}

module.exports = LetterboxdClient;
