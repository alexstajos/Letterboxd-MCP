const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

function envInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DEFAULT_HTTP_TIMEOUT_MS = envInt(process.env.LETTERBOXD_HTTP_TIMEOUT_MS, 20000);
const MAX_REDIRECTS = envInt(process.env.LETTERBOXD_MAX_REDIRECTS, 5);

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
    this.browser = null;
    this.browserContext = null;

    if (process.env.LETTERBOXD_COOKIE) {
      this._storeCookies(process.env.LETTERBOXD_COOKIE);
      if (this.cookieHeader.includes('letterboxd.user.CURRENT') || this.cookieHeader.includes('persona')) {
        this.isLoggedIn = true;
      }
    }
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
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
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
    const path = cursor.startsWith('/') ? cursor : `/${cursor}`;
    return `${this.baseUrl}${path}`.replace(/([^:]\/)\/+/g, "$1");
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

        const posterImg = node.find('img').first();
        let posterUrl = posterImg.attr('src') || '';
        // Handle lazy loading or srcset for better resolution
        const srcset = posterImg.attr('srcset');
        if (srcset) {
            const sources = srcset.split(',').map(s => s.trim().split(' ')[0]);
            if (sources.length > 0) posterUrl = sources[sources.length - 1];
        }

        const rating =
          node.find('.rating').first().text().trim() ||
          poster.find('.rating').first().text().trim() ||
          node.find('[data-rating]').attr('data-rating') ||
          poster.attr('data-rating') ||
          null;

        if (!slug || seen.has(slug)) return;
        seen.add(slug);
        items.push({ 
            title: title || slug.replace(/-/g, ' ').trim(), 
            slug,
            posterUrl: posterUrl.startsWith('http') ? posterUrl : (posterUrl ? `https:${posterUrl}` : ''),
            ...(rating ? { rating } : {})
        });
      });
    return items;
  }

  async fetchPage(url, scraperFunc, limit) {
    const html = await this.fetchHtml(url);
    const $ = cheerio.load(html);
    let items = scraperFunc($);
    const nextLink =
      $('.paginate-next a, .next a, a.paginate-next, a.next, .pagination a.next').first().attr('href') ||
      $('link[rel="next"]').attr('href') ||
      null;
    const nextCursor = nextLink ? new URL(nextLink, url).toString() : null;
    return { items, nextCursor };
  }

  async _getSigninForm() {
    // 1. Charge la page pour obtenir le cookie CSRF initial
    const response = await this._request('GET', `${this.baseUrl}/sign-in/`, { skipLogin: true });
    const csrf = this.cookies['com.xk72.webparts.csrf'] || '';
    return { 
      action: `${this.baseUrl}/user/login.do`, 
      fields: { '__csrf': csrf } 
    };
  }

  async login(username, password) {
    this.username = username;
    const { action, fields } = await this._getSigninForm();
    
    const form = new URLSearchParams();
    form.append('__csrf', fields['__csrf'] || '');
    form.append('username', username);
    form.append('password', password);
    form.append('remember', 'on');

    const response = await this._request('POST', action, {
      data: form.toString(),
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${this.baseUrl}/sign-in/`,
        'Origin': this.baseUrl
      },
    });

    // On vérifie la présence des cookies de session vitaux
    this.isLoggedIn = !!(this.cookies['letterboxd.user.CURRENT'] || this.cookies['persona']);

    if (this.isLoggedIn) {
        // Fallback immediate si username n'est pas un email
        if (username && !username.includes('@')) {
            this.username = username;
        }

        // Optionnel : on essaie de confirmer le vrai pseudo (slug)
        try {
            const home = await this._request('GET', this.baseUrl, { skipLogin: true });
            const $ = cheerio.load(home.data);
            const slug = $('body').attr('data-user-name') || 
                         $('.nav-account a').attr('href')?.split('/').filter(Boolean).pop() ||
                         $('.nav-main-right .nav-account > a').attr('href')?.split('/').filter(Boolean).pop();
            if (slug && !slug.includes('@')) this.username = slug;
        } catch (e) {}
        return true;
    } else {
        throw new Error('Login failed: Invalid credentials or session blocked by Letterboxd.');
    }
  }

  async ensureLoggedIn() {
    if (this.isLoggedIn) {
      if (!this.username || this.username.includes('@')) {
        let envUser = process.env.LETTERBOXD_USERNAME;
        try {
          const homeHtml = await this.fetchHtml(this.baseUrl, { skipLogin: true });
          const $home = cheerio.load(homeHtml);
          const userSlug = $home('body').attr('data-user-name') || 
                           $home('.nav-account a').attr('href')?.split('/').filter(Boolean).pop() ||
                           $home('.nav-main-right .nav-account > a').attr('href')?.split('/').filter(Boolean).pop();
          if (userSlug) {
            this.username = userSlug;
          } else if (envUser && !envUser.includes('@')) {
            this.username = envUser;
          }
        } catch (e) {
          if (envUser && !envUser.includes('@')) this.username = envUser;
        }
      }
      return;
    }
    if (this.loginPromise) return this.loginPromise;
    
    // Check again if cookies were set manually after constructor
    if (this.cookieHeader && (this.cookieHeader.includes('letterboxd.user.CURRENT') || this.cookieHeader.includes('persona'))) {
        this.isLoggedIn = true;
        return this.ensureLoggedIn();
    }

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
    const synopsis =
      $('.truncate p').text().trim() ||
      $('.review-body-text').first().text().trim() ||
      $('.body-text').first().text().trim();

    const rating =
      (filmData.aggregateRating && filmData.aggregateRating.ratingValue) ||
      $('.average-rating a, .average-rating').first().text().trim();

    const posterUrl = $('meta[property="og:image"]').attr('content') || '';
    
    const cast = $('.cast-list .actor').map((i, el) => $(el).text().trim()).get().join(', ');
    const runtimeText = $('.text-footer').text().match(/(\d+)\s+mins/);
    const runtime = runtimeText ? `${runtimeText[1]} min` : '';

    return {
      title: filmData.name || $('.headline-1').text().trim() || $('h1').first().text().trim(),
      year,
      director: directors || $('.director a').map((i, el) => $(el).text().trim()).get().join(', '),
      synopsis,
      cast,
      runtime,
      rating,
      genre: genres.join(', '),
      posterUrl,
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

    const bio = $('.bio p').text().trim();
    const stats = {};
    $('.profile-stats a').each((i, el) => {
      const label = $(el).find('.definition').text().trim();
      const value = $(el).find('.value').text().trim();
      if (label) stats[label] = value;
    });

    const displayName = $('h1').first().text().trim();
    return { username, displayName, bio, stats, url };
  }

  _extractUserLists($, root, username) {
    const scope = root && root.length ? root : $.root();
    const items = [];
    const seen = new Set();

    // Letterboxd private lists or lists viewed by owner can be in different containers
    const listNodes = scope.find(
      '.list-set, .list, li.list-set, li.list, .list-entry, .list-preview, article, section, .table-list tr'
    );

    if (listNodes.length) {
      listNodes.each((i, el) => {
        const node = $(el);
        const link =
          node.find('a[href*="/list/"]').first().attr('href') ||
          node.find('a.list-link').first().attr('href') ||
          node.attr('href') || '';
        
        if (!link || link.includes('/new/')) return;

        const parts = link.split('/').filter(Boolean);
        const listIndex = parts.indexOf('list');
        if (listIndex < 0) return;
        
        const slug = parts[listIndex + 1];
        if (!slug || seen.has(slug)) return;

        const title =
          node.find('.list-title, .title, h2 a, h3 a, h2, h3, .name').first().text().trim() ||
          node.find('a[href*="/list/"]').first().text().trim() ||
          slug.replace(/-/g, ' ');

        const description =
          node.find('.body-text, .list-description, .notes, p').first().text().trim() || '';

        const isPrivate = node.find('.icon-lock, .-private, .private').length > 0;

        const url = link.startsWith('http')
          ? link
          : `${this.baseUrl}${link.startsWith('/') ? link : `/${link}`}`;
        
        const owner = username || (listIndex > 0 ? parts[listIndex - 1] : null);

        items.push({ 
            title: isPrivate ? `[PRIVÉE] ${title}` : title, 
            slug, 
            url, 
            description, 
            isPrivate,
            username: owner 
        });
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

    return { username, items };
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
          const summary = $(el).find('.body-text').text().trim();
          
          if (title && slug) {
            items.push({ 
                title, 
                slug, 
                reviewId, 
                rating, 
                summary, 
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

  async _ensureBrowser() {
    if (this.browser) return;
    this.browser = await chromium.launch({ 
        headless: true,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--use-gl=desktop',
            '--no-sandbox'
        ]
    });
    this.browserContext = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });
    
    await this.browserContext.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const cookies = Object.entries(this.cookies).map(([name, value]) => ({
      name,
      value,
      domain: '.letterboxd.com',
      path: '/'
    }));
    await this.browserContext.addCookies(cookies);
  }

  async _performAction(url, actionFn) {
    await this._ensureBrowser();
    const page = await this.browserContext.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      await actionFn(page);
      
      // Sync back cookies from browser
      const newCookies = await this.browserContext.cookies();
      for (const cookie of newCookies) {
        this.cookies[cookie.name] = cookie.value;
      }
      this.cookieHeader = Object.entries(this.cookies)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
        
      return true;
    } finally {
      await page.close();
    }
  }

  async rateFilm(slug, rating) {
    await this.ensureLoggedIn();
    return this._performAction(`${this.baseUrl}/film/${slug}/`, async (page) => {
      const stars = Math.ceil(rating);
      // Letterboxd uses a specific UI for rating, we click the appropriate star
      const selector = `.rateit-range > div:nth-child(${stars})`;
      await page.waitForSelector('.rateit-range', { timeout: 5000 });
      
      // Simple range input update as fallback, then click
      await page.evaluate(({stars}) => {
          const input = document.querySelector('#frm-rating');
          if (input) {
              input.value = stars;
              input.dispatchEvent(new Event('change', { bubbles: true }));
          }
      }, {stars});
      
      // Try to click the visual star to trigger the AJAX save
      try {
          const starWidth = 13; // From your previous analysis
          await page.click('.rateit-range', { position: { x: (stars * starWidth) - 5, y: 10 } });
      } catch (e) {}
      
      await page.waitForTimeout(1000); // Wait for AJAX
    });
  }

  async addToWatched(slug, remove = false) {
    await this.ensureLoggedIn();
    return this._performAction(`${this.baseUrl}/film/${slug}/`, async (page) => {
      // Sélecteur pour le bouton "Watch" (déjà vu) identifié précédemment
      const watchBtn = page.locator('.sidebar .action.-watch, .sidebar .watch-button, .sidebar .action-large.-watch').first();
      
      await watchBtn.waitFor({ state: 'visible', timeout: 10000 });
      
      const classAttr = await watchBtn.getAttribute('class') || '';
      const isCurrentlyWatched = classAttr.includes('-active') || classAttr.includes('own');
      
      if ((!remove && !isCurrentlyWatched) || (remove && isCurrentlyWatched)) {
        await watchBtn.click();
        await page.waitForTimeout(2000);
        console.log(`Film ${slug} marqué comme ${remove ? 'non vu' : 'vu'}.`);
      }
    });
  }

  async addToWatchlist(slug, remove = false) {
    await this.ensureLoggedIn();
    return this._performAction(`${this.baseUrl}/film/${slug}/`, async (page) => {
      // The exact button found in debug:
      const watchlistBtn = page.locator('a.add-to-watchlist, .action-large.-watchlist').first();
      
      await watchlistBtn.waitFor({ state: 'visible', timeout: 10000 });
      
      const classAttr = await watchlistBtn.getAttribute('class') || '';
      const isCurrentlyIn = classAttr.includes('-remove') || classAttr.includes('own') || classAttr.includes('-active');
      
      console.log(`Bouton Watchlist trouve. Etat actuel : ${isCurrentlyIn ? 'Dans la liste' : 'Pas dans la liste'}`);

      if ((!remove && !isCurrentlyIn) || (remove && isCurrentlyIn)) {
        await watchlistBtn.click();
        console.log('Clic effectue sur le bouton Watchlist.');
        // Wait for the class to change or for a short delay
        await page.waitForTimeout(3000);
      } else {
        console.log('Action non necessaire (deja dans l\'etat souhaite).');
      }
    });
  }

  async toggleLike(slug, reviewId = null, remove = false) {
    await this.ensureLoggedIn();
    const url = `${this.baseUrl}/film/${slug}/`;
    return this._performAction(url, async (page) => {
        if (reviewId) {
            const likeBtn = page.locator(`.review-like[data-review-id="${reviewId}"]`);
            await likeBtn.click();
        } else {
            // Target only the main film like button in the sidebar
            const likeBtn = page.locator('.sidebar .like-link-target, #featured-film-header .like-link-target').first();
            const classAttr = await likeBtn.getAttribute('class') || '';
            const isLiked = classAttr.includes('active');
            if ((!remove && !isLiked) || (remove && isLiked)) {
                await likeBtn.click();
            }
        }
        await page.waitForTimeout(1000);
    });
  }

  async writeReview(slug, options = {}) {
    await this.ensureLoggedIn();
    return this._performAction(`${this.baseUrl}/film/${slug}/`, async (page) => {
      const filmId = await page.locator('[data-film-id]').first().getAttribute('data-film-id');
      const csrf = await page.evaluate(() => document.cookie.split('; ').find(r => r.startsWith('com.xk72.webparts.csrf='))?.split('=')[1]);

      console.log(`Publication AJAX via /s/save-diary-entry pour le film ${filmId}...`);
      
      const debugInfo = await page.evaluate(async ({filmId, reviewText, rating, containsSpoilers, csrf}) => {
          const body = new URLSearchParams();
          body.append('__csrf', csrf);
          body.append('filmId', filmId);
          body.append('review', reviewText || '');
          if (rating) body.append('rating', String(rating));
          if (containsSpoilers) body.append('containsSpoilers', 'on');
          
          const today = new Date().toISOString().split('T')[0];
          body.append('viewingDateStr', today);
          body.append('addDate', 'on');

          try {
              const res = await fetch('/s/save-diary-entry', {
                  method: 'POST',
                  headers: { 
                      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 
                      'X-Requested-With': 'XMLHttpRequest' 
                  },
                  body: body.toString()
              });
              const text = await res.text();
              return { status: res.status, ok: res.ok, body: text };
          } catch (e) {
              return { error: e.message };
          }
      }, {filmId, reviewText: options.reviewText, rating: options.rating, containsSpoilers: options.containsSpoilers, csrf});

      console.log('Réponse Letterboxd :', JSON.stringify(debugInfo));
      await page.waitForTimeout(2000);
      return debugInfo.ok;
    });
  }

  async addToList(slug, listSlug) {
    await this.ensureLoggedIn();
    return this._performAction(`${this.baseUrl}/film/${slug}/`, async (page) => {
      console.log('Ouverture du menu "Add to lists..."');
      await page.click('.menu-item-add-to-list');
      await page.waitForSelector('.js-list-filter-item', { timeout: 10000 });
      
      // On nettoie le nom recherche pour etre tres souple
      const cleanSearch = listSlug.replace(/-/g, ' ').trim().toLowerCase();
      
      // On cherche parmi tous les items de liste
      const allListItems = await page.locator('.js-list-filter-item').all();
      let listOption = null;
      
      for (const item of allListItems) {
          const text = await item.innerText();
          if (text.toLowerCase().includes(cleanSearch)) {
              listOption = item;
              break;
          }
      }
      
      if (listOption) {
          const checkbox = listOption.locator('input[type="checkbox"]');
          const listId = await checkbox.getAttribute('value');
          const filmId = await page.locator('[data-film-id]').first().getAttribute('data-film-id');
          const csrf = await page.evaluate(() => document.cookie.split('; ').find(r => r.startsWith('com.xk72.webparts.csrf='))?.split('=')[1]);

          console.log(`Injection directe AJAX : Film ${filmId} -> Liste ${listId}`);
          
          await page.evaluate(async ({filmId, listId, csrf}) => {
              await fetch('/s/add-film-to-list', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
                  body: `__csrf=${csrf}&filmId=${filmId}&filmListId=${listId}`
              });
          }, {filmId, listId, csrf});

          await page.waitForTimeout(3000);
          console.log('Requête AJAX envoyée.');
      } else {
          throw new Error("Liste non trouvée.");
      }
    });
  }

  async createList(title, description, isPrivate = false, filmSlugs = []) {
    await this.ensureLoggedIn();
    return this._performAction(this.baseUrl, async (page) => {
      const csrf = await page.evaluate(() => document.cookie.split('; ').find(r => r.startsWith('com.xk72.webparts.csrf='))?.split('=')[1]);
      
      const filmIds = [];
      for (const slug of filmSlugs) {
          const html = await this.fetchHtml(`${this.baseUrl}/film/${slug}/`, { skipLogin: true });
          const $ = cheerio.load(html);
          const id = $('[data-film-id]').first().attr('data-film-id');
          if (id) filmIds.push(id);
      }

      if (filmIds.length === 0) throw new Error("At least one film is required.");

      console.log(`Création AJAX de la liste "${title}" avec film ID ${filmIds[0]}...`);
      
      await page.evaluate(async ({title, description, isPrivate, filmIds, csrf}) => {
          const body = new URLSearchParams();
          body.append('__csrf', csrf);
          body.append('filmListId', ''); 
          body.append('name', title);
          body.append('notes', description);
          body.append('tags', '');
          body.append('numberedList', 'false');
          if (isPrivate) body.append('isPrivate', 'on');
          filmIds.forEach(id => body.append('filmId', id));
          
          await fetch('/s/update-list', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
              body: body.toString()
          });
      }, {title, description, isPrivate, filmIds, csrf});

      await page.waitForTimeout(4000);
      console.log('✅ Liste créée via API interne.');
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

module.exports = LetterboxdClient;
