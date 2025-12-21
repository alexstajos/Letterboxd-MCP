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
    if (typeof options.loginForReads === 'boolean') {
      this.loginForReads = options.loginForReads;
    } else if (process.env.LETTERBOXD_LOGIN_FOR_READS !== undefined) {
      this.loginForReads = process.env.LETTERBOXD_LOGIN_FOR_READS !== 'false';
    } else {
      this.loginForReads = true;
    }

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

  _extractPosterItems($, root) {
    const scope = root && root.length ? root : $.root();
    const items = [];
    const seen = new Set();
    scope
      .find('.poster-grid .griditem, .poster-container, .poster-list .posteritem, .film-poster')
      .each((i, el) => {
        const node = $(el);
        const poster = node.hasClass('film-poster') ? node : node.find('.film-poster').first();
        const dataName =
          node.attr('data-film-name') ||
          node.attr('data-item-name') ||
          poster.attr('data-film-name') ||
          poster.attr('data-item-name') ||
          node.find('[data-film-name]').attr('data-film-name') ||
          node.find('[data-item-name]').attr('data-item-name') ||
          '';
        const imgAlt =
          node.find('img').attr('alt') ||
          poster.find('img').attr('alt') ||
          node.find('img').attr('title') ||
          node.attr('aria-label') ||
          '';
        const title = (dataName || imgAlt || '').replace(/^Poster for /, '').trim();

        const slugFromData =
          node.attr('data-film-slug') ||
          node.attr('data-item-slug') ||
          poster.attr('data-film-slug') ||
          poster.attr('data-item-slug') ||
          node.find('[data-film-slug]').attr('data-film-slug') ||
          node.find('[data-item-slug]').attr('data-item-slug') ||
          '';
        const link =
          node.find('a[href*="/film/"]').first().attr('href') ||
          poster.find('a[href*="/film/"]').first().attr('href') ||
          '';
        const slugFromLink = link ? link.split('/').filter(Boolean).pop() : '';
        const slug = slugFromData || slugFromLink;

        if (!slug || seen.has(slug)) return;
        seen.add(slug);
        items.push({ title: title || slug.replace(/-/g, ' ').trim(), slug });
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
    const nextLink =
      $('.paginate-next a, .next a, a.paginate-next, a.next').first().attr('href') ||
      $('link[rel="next"]').attr('href') ||
      null;
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
    let username = process.env.LETTERBOXD_USERNAME;
    let password = process.env.LETTERBOXD_PASSWORD;
    if ((!username || !password) && process.env.LETTERBOXD_CREDENTIALS) {
      const [user, ...rest] = process.env.LETTERBOXD_CREDENTIALS.split(':');
      if (user && rest.length) {
        username = user;
        password = rest.join(':');
      }
    }
    if (!username || !password) {
      throw new Error(
        'Missing Letterboxd credentials. Set LETTERBOXD_USERNAME/LETTERBOXD_PASSWORD or LETTERBOXD_CREDENTIALS, or disable with LETTERBOXD_LOGIN_FOR_READS=false.'
      );
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
    if (!listSlug) {
      return this.getLists(username, options);
    }

    const url = this.resolveCursor(options.cursor, `${this.baseUrl}/${username}/list/${listSlug}/`);
    const html = await this.fetchHtml(url);
    const $ = cheerio.load(html);
    const list = this._extractListMeta($, url, username, listSlug);

    let items = this._extractPosterItems($);
    const normalizedLimit = normalizeLimit(options.limit);
    if (normalizedLimit !== undefined) {
      items = items.slice(0, normalizedLimit);
    }

    const nextLink =
      $('.paginate-next a, .next a, a.paginate-next, a.next').first().attr('href') ||
      $('link[rel="next"]').attr('href') ||
      null;
    const nextCursor = nextLink ? new URL(nextLink, url).toString() : null;

    return { list, items, nextCursor };
  }

  async getReview(username, filmSlug, reviewId) {
    const suffix = reviewId ? `/${reviewId}/` : '/';
    const url = `${this.baseUrl}/${username}/film/${filmSlug}${suffix}`;
    const html = await this.fetchHtml(url);
    const $ = cheerio.load(html);

    const filmTitle =
      $('.film-viewing-info-wrapper .name a').first().text().trim() ||
      $('.headline-1 a').first().text().trim() ||
      $('h1').first().text().trim();

    const bodyContainer = $('.js-review-body').first();
    let reviewText = '';
    if (bodyContainer.length) {
      bodyContainer.find('br').replaceWith('\n');
      const paragraphs = bodyContainer.find('p');
      if (paragraphs.length) {
        reviewText = paragraphs
          .map((i, el) => $(el).text().trim())
          .get()
          .join('\n\n');
      } else {
        reviewText = bodyContainer.text().trim();
      }
    } else {
      // Fallback for older layouts or if js-review-body is missing
      reviewText =
        $('.review .body-text, .review-body, .body-text').first().text().trim();
    }

    const rating =
      $('.rating-large').text().trim() ||
      $('meta[name="twitter:data2"]').attr('content') ||
      '';

    let date = '';
    const dateMeta = $('meta[property="og:type"][content="letterboxd:review"] ~ meta[content^="20"]'); 
    // The meta content date usually appears near the top, but finding it by content regex in cheerio is hard directly.
    // Let's use the visible date.
    const dateLink = $('.view-date .date-links a').last();
    if (dateLink.length) {
      date = $('.view-date').text().replace(/\s+/g, ' ').trim();
    } else {
      date = $('.view-date').text().replace(/\s+/g, ' ').trim();
    }

    const likeCountRaw =
      $('.review-like').attr('data-count') ||
      $('.like-link-target').attr('data-count');
    const likeCount = likeCountRaw ? parseInt(likeCountRaw, 10) : 0;

    // Check for spoilers
    const spoiler = $('.contains-spoilers').length > 0;

    return {
      filmTitle,
      username,
      filmSlug,
      reviewText,
      rating,
      date,
      likeCount,
      spoiler,
      url,
    };
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

  _extractUserLists($, root, username) {
    const scope = root && root.length ? root : $.root();
    const items = [];
    const seen = new Set();

    const listNodes = scope.find(
      '.list-set, .list, li.list-set, li.list, .list-entry, .list-preview, article, section'
    );

    if (listNodes.length) {
      listNodes.each((i, el) => {
        const node = $(el);
        const link =
          node.find('a[href*="/list/"]').first().attr('href') ||
          node.find('a.list-link').first().attr('href') ||
          '';
        if (!link) return;

        const parts = link.split('/').filter(Boolean);
        const listIndex = parts.indexOf('list');
        const slug = listIndex >= 0 ? parts[listIndex + 1] : parts[parts.length - 1];
        if (!slug || seen.has(slug)) return;

        const title =
          node.find('.list-title, .title, h2 a, h3 a, h2, h3').first().text().trim() ||
          node.find('a[href*="/list/"]').first().text().trim() ||
          slug.replace(/-/g, ' ');

        const description =
          node.find('.body-text, .list-description, .notes, p').first().text().trim() || '';

        const metaText =
          node.find('.list-meta, .list-details, .metadata, .count').text().trim() ||
          node.text().trim();
        const countMatch = metaText.match(/(\d+[\d,]*)\s*(film|films)/i);
        const itemCount = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null;

        const url = link.startsWith('http')
          ? link
          : `${this.baseUrl}${link.startsWith('/') ? link : `/${link}`}`;
        const owner = username || (listIndex > 0 ? parts[listIndex - 1] : null);

        items.push({ title, slug, url, description, itemCount, username: owner });
        seen.add(slug);
      });
    }

    if (!items.length) {
      $('a[href*="/list/"]').each((i, el) => {
        const link = $(el).attr('href');
        if (!link) return;
        const parts = link.split('/').filter(Boolean);
        const listIndex = parts.indexOf('list');
        if (listIndex < 0 || !parts[listIndex + 1]) return;
        const slug = parts[listIndex + 1];
        if (seen.has(slug)) return;
        const title = $(el).text().trim() || slug.replace(/-/g, ' ');
        const url = link.startsWith('http')
          ? link
          : `${this.baseUrl}${link.startsWith('/') ? link : `/${link}`}`;
        const owner = username || (listIndex > 0 ? parts[listIndex - 1] : null);
        items.push({ title, slug, url, description: '', itemCount: null, username: owner });
        seen.add(slug);
      });
    }

    return items;
  }

  _extractListMeta($, url, username, listSlug) {
    const title =
      $('meta[property="og:title"]').attr('content')?.replace(/\s*•\s*Letterboxd/i, '').trim() ||
      $('h1').first().text().trim() ||
      listSlug;

    const description =
      $('meta[name="description"]').attr('content') ||
      $('.list-description .body-text, .list-notes .body-text, .list-description, .list-notes')
        .first()
        .text()
        .trim() ||
      '';

    const metaText =
      $('.list-meta, .list-details, .metadata').first().text().trim() ||
      $('.list-meta').text().trim();
    const countMatch = metaText.match(/(\d+[\d,]*)\s*(film|films)/i);
    const itemCount = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null;

    const ownerLink =
      $('.list-author a, .creator a, .list-meta a[href^="/"]').first().attr('href') || '';
    const owner =
      ownerLink.split('/').filter(Boolean)[0] ||
      username ||
      null;

    return {
      title,
      description,
      itemCount,
      url,
      username: owner,
      slug: listSlug,
    };
  }

  async getLists(username, options = {}) {
    const url = this.resolveCursor(options.cursor, `${this.baseUrl}/${username}/lists/`);
    return this.fetchPage(url, ($) => this._extractUserLists($, null, username), options.limit);
  }

  _findFavoritesSection($) {
    const selectors = ['#favourites', '#favorites', '#favourite-films', '#favorite-films'];
    for (const selector of selectors) {
      const section = $(selector).first();
      if (section.length) return section;
    }

    const dataSection = $('[data-component-class*="Favor"], [data-component*="Favor"]').first();
    if (dataSection.length) return dataSection;

    const byHeading = $('section')
      .filter((i, el) => {
        const heading = $(el).find('h2, h3').first().text().trim().toLowerCase();
        return heading.includes('favorite') || heading.includes('favourite');
      })
      .first();
    if (byHeading.length) return byHeading;
    return null;
  }

  async getMemberPinned(username) {
    const url = `${this.baseUrl}/${username}/`;
    const html = await this.fetchHtml(url);
    const $ = cheerio.load(html);
    let items = [];

    const section = this._findFavoritesSection($);
    if (section && section.length) {
      items = this._extractPosterItems($, section);
    }

    if (!items.length) {
      const heading = $('h2, h3')
        .filter((i, el) => {
          const text = $(el).text().trim().toLowerCase();
          return text.includes('favorite') || text.includes('favourite');
        })
        .first();
      if (heading.length) {
        const container = heading.closest('section, div, li, article');
        if (container.length) {
          items = this._extractPosterItems($, container);
        }
        if (!items.length) {
          const next = heading.parent().next();
          if (next.length) {
            items = this._extractPosterItems($, next);
          }
        }
      }
    }

    if (!items.length) {
      const candidates = $('[id*="fav"], [class*="fav"]').filter((i, el) => {
        const id = ($(el).attr('id') || '').toLowerCase();
        const cls = ($(el).attr('class') || '').toLowerCase();
        return id.includes('favor') || id.includes('favour') || cls.includes('favor') || cls.includes('favour');
      });

      let best = [];
      candidates.each((i, el) => {
        const found = this._extractPosterItems($, $(el));
        if (found.length > best.length) {
          best = found;
        }
      });
      items = best;
    }

    if (!items.length) {
      items = this._extractPosterItems($);
    }

    return { username, items: items.slice(0, 4) };
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
          const titleLink = $(el).find('.name a').first();
          const title = titleLink.text().trim();
          const link = titleLink.attr('href') || '';
          
          let reviewId = '';
          let slug = '';
          
          if (link) {
            const parts = link.split('/').filter(Boolean);
            // Expected: [username, 'film', slug, id?]
            if (parts.indexOf('film') >= 0) {
                const filmIndex = parts.indexOf('film');
                if (parts[filmIndex + 1]) slug = parts[filmIndex + 1];
                if (parts[filmIndex + 2]) reviewId = parts[filmIndex + 2];
            }
          }

          if (!slug) {
             slug = $(el).find('.react-component').attr('data-item-slug') || '';
          }

          const rating = $(el).find('.rating').text().trim();
          const summaryRaw = $(el).find('.body-text').text().trim();
          const summary = this._truncateText(summaryRaw);
          
          if (title && slug) {
            items.push({ 
                title, 
                slug, 
                reviewId, 
                rating, 
                summary: summary.text, 
                url: link ? `${this.baseUrl}${link}` : '' 
            });
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
