const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

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

function normalizeTitle(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickBestTitleMatch(inputTitle, candidates) {
  const normalizedInput = normalizeTitle(inputTitle);

  // Exact normalized match first
  const exact = candidates.find(c =>
    normalizeTitle(c.title) === normalizedInput
  );

  if (exact) return exact;

  // Partial containment match
  const partial = candidates.find(c =>
    normalizeTitle(c.title).includes(normalizedInput)
  );

  if (partial) return partial;

  // Fallback: first result
  return candidates[0];
}

class LetterboxdClient {
  constructor(options = {}) {
    this.baseUrl = 'https://letterboxd.com';
    this.sessionPath = path.resolve(__dirname, 'letterboxd-session.json');
    this.browser = null;
    this.context = null;
    this.page = null;
    this.username = null;
    this.isLoggedIn = false;

    this.loginForReads =
      process.env.LETTERBOXD_LOGIN_FOR_READS !== 'false';
  }

  // ===============================
  // BROWSER INIT
  // ===============================

  async _initBrowser() {
    if (this.browser) return;

    this.browser = await chromium.launch({
      headless: true, // or true for MCP headless
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--start-maximized',
      ],
    });

    const hasSession = fs.existsSync(this.sessionPath);

    // merge context options
    const contextOptions = {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York'
    };

    this.context = await this.browser.newContext(contextOptions);

    // Anti-bot / navigator patching
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    this.page = await this.context.newPage();

    if (hasSession) {
      await this.page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
      this.isLoggedIn = await this._checkLoggedIn();
      if (this.isLoggedIn) {
        await this._refreshUsernameFromSession();
      }
    }
  }


  async init() {
    return;
  }

  async _checkLoggedIn() {
    return await this.page.locator('.nav-account').count() > 0;
  }

  async _refreshUsernameFromSession() {
    if (!this.page) return null;

    const href =
      await this.page.locator('.nav-account a[href^="/"]').first().getAttribute('href') || '';
    if (!href) return null;

    const parsed = href.split('/').filter(Boolean)[0] || null;
    if (parsed) {
      this.username = parsed;
    }
    return parsed;
  }

  // ===============================
  // LOGIN (Playwright Only)
  // ===============================

  async login(username, password) {
    await this._initBrowser(); // ensures this.page exists

    await this.page.goto(`${this.baseUrl}/sign-in/`, {
      waitUntil: 'domcontentloaded',
    });

    await this.page.fill('input[name="username"]', username);
    await this.page.fill('input[name="password"]', password);

    await Promise.all([
      this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      this.page.click('button[type="submit"]')
    ]);

    // Go to homepage to verify session
    await this.page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });

    const isLoggedIn = await this._checkLoggedIn();

    if (!isLoggedIn) {
      throw new Error('Login failed - session not authenticated.');
    }

    //await this.context.storageState({ path: this.sessionPath });

    this.isLoggedIn = true;
    const resolvedUsername = await this._refreshUsernameFromSession();
    this.username = resolvedUsername || username;

    if (
      username &&
      resolvedUsername &&
      resolvedUsername.toLowerCase() !== String(username).trim().toLowerCase()
    ) {
      throw new Error(
        `Authenticated as "${resolvedUsername}" but expected "${username}".`
      );
    }
  }

  async fetchHtml(url, waitSelector = 'body') {
    await this._initBrowser();

    if (this.loginForReads) {
      await this.ensureLoggedIn();
    }

    await this.page.goto(url, { waitUntil: 'domcontentloaded' });

    if (waitSelector) {
      await this.page.waitForSelector(waitSelector, { timeout: 10000 });
    }

    return await this.page.content();
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

        // Try multiple places for title
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

        // Try multiple places for slug
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

        // Ensure MCP responses are consistent: skip entries missing slug.
        if (!slug || seen.has(slug)) return;
        seen.add(slug);

        // Poster image
        const posterImg = node.find('img').first();
        let posterUrl = posterImg.attr('src') || '';
        const srcset = posterImg.attr('srcset');
        if (srcset) {
          const sources = srcset.split(',').map((s) => s.trim().split(' ')[0]);
          if (sources.length > 0) posterUrl = sources[sources.length - 1];
        }

        const rating =
          node.find('.rating').first().text().trim() ||
          poster.find('.rating').first().text().trim() ||
          node.find('[data-rating]').attr('data-rating') ||
          poster.attr('data-rating') ||
          null;

        items.push({
          title: title || slug.replace(/-/g, ' ').trim(),
          slug,
          posterUrl: posterUrl.startsWith('http') ? posterUrl : (posterUrl ? `https:${posterUrl}` : ''),
          ...(rating ? { rating } : {}),
        });
      });
    return items;
  }

  async fetchPage(url, scraperFunc, limit, waitSelector = 'body') {
    const html = await this.fetchHtml(url, waitSelector);
    const $ = cheerio.load(html);

    let items = scraperFunc($);

    if (limit && Array.isArray(items)) {
      items = items.slice(0, limit);
    }

    const nextLink =
      $('.paginate-next a, .next a, a.paginate-next, a.next, .pagination a.next')
        .first()
        .attr('href') ||
      $('link[rel="next"]').attr('href') ||
      null;

    const nextCursor = nextLink
      ? new URL(nextLink, url).toString()
      : null;

    return { items, nextCursor };
  }

  async ensureLoggedIn() {
    if (this.isLoggedIn) {
      if (!this.username) {
        await this._refreshUsernameFromSession();
      }
      return;
    }

    const username = process.env.LETTERBOXD_USERNAME;
    const password = process.env.LETTERBOXD_PASSWORD;

    if (!username || !password) {
      throw new Error('Missing LETTERBOXD_USERNAME / LETTERBOXD_PASSWORD');
    }

    await this.login(username, password);
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
          const titleElement = $(el)
            .find('.film-title-wrapper a, .name a')
            .first();

          const title =
            titleElement.text().trim() ||
            $(el).find('.name').text().trim();

          const link =
            titleElement.attr('href') ||
            $(el).find('a').attr('href');

          if (!title || !link) return;

          // Extract year from metadata text
          const metadataText = $(el)
            .find('.metadata, .film-metadata, small')
            .text()
            .trim();

          const yearMatch = metadataText.match(/\b(18|19|20)\d{2}\b/);
          const year = yearMatch ? parseInt(yearMatch[0], 10) : null;

          results.push({
            title,
            url: `${this.baseUrl}${link}`,
            slug: link.split('/').filter(Boolean).pop(),
            year,
          });
        });

        return results;
      },
      options.limit,
      '.results li'
    );

    return { items, nextCursor };
  }

  async getFilm(slug) {
    const url = `${this.baseUrl}/film/${slug}/`;
    const html = await this.fetchHtml(url, 'h1.headline-1');
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

  /**
   * Fetch all lists for a user by automatically handling pagination.
   * Returns an array of list metadata objects.
   */
  async getAllLists(username) {
    let allLists = [];
    let cursor = null;

    do {
      const { items, nextCursor } = await this.getLists(username, { cursor });
      allLists = allLists.concat(items);
      cursor = nextCursor;
    } while (cursor);

    return allLists;
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

  _extractUserLists($, root = null, username) {
    const scope = root && root.length ? root : $.root();
    const lists = [];
    const seen = new Set();

    scope.find('.list-item, .list-summary, .list-card').each((i, el) => {
      const node = $(el);

      // Extract title
      const title =
        node.find('.list-title a').first().text().trim() ||
        node.find('h2, h3').first().text().trim() ||
        node.attr('data-list-title') ||
        '';

      // Extract link and slug
      const link =
        node.find('a[href*="/list/"]').first().attr('href') ||
        node.attr('href') ||
        '';
      const slug = link ? link.split('/').filter(Boolean).pop() : '';

      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      // Extract optional description
      const description =
        node.find('.list-description, .body-text').first().text().trim() || '';

      // Extract item count
      const metaText = node.find('.list-meta, .metadata').first().text().trim() || '';
      const countMatch = metaText.match(/(\d+[\d,]*)\s*(film|films)/i);
      const itemCount = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null;

      lists.push({
        title: title || slug.replace(/-/g, ' ').trim(),
        slug,
        url: `${this.baseUrl}${link}`,
        description,
        itemCount,
        username: username || null,
      });
    });

    return lists;
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
    if (this.isLoggedIn && !this.username) {
      await this._refreshUsernameFromSession();
    }
    return { username: this.username, loggedIn: this.isLoggedIn };
  }

  async _performAction(url, actionFn) {
    await this._initBrowser();
    await this.ensureLoggedIn();

    const page = await this.context.newPage();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      await page.waitForSelector('body', { timeout: 10000 });
      await actionFn(page);
      //await this.context.storageState({ path: this.sessionPath });
      return true;
    } finally {
      await page.close();
    }
  }

  async rateFilm(slug, rating) {
    return this._performAction(`${this.baseUrl}/film/${slug}/`, async (page) => {
      const stars = Math.ceil(rating);
      await page.waitForSelector('.rateit-range', { timeout: 5000 });

      // Simple range input update as fallback, then click
      await page.evaluate(({ stars }) => {
        const input = document.querySelector('#frm-rating');
        if (input) {
          input.value = stars;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, { stars });

      // Try to click the visual star to trigger the AJAX save
      try {
        const starWidth = 13;
        await page.click('.rateit-range', { position: { x: (stars * starWidth) - 5, y: 10 } });
      } catch {}

      await page.waitForTimeout(1000); // Wait for AJAX
    });
  }

  async addToWatched(slug, remove = false) {
    return this._performAction(`${this.baseUrl}/film/${slug}/`, async (page) => {
      const watchSelector = '.action.-watch.ajax-click-action';

      await page.waitForSelector(watchSelector, { timeout: 10000 });

      const watchAction = page.locator(watchSelector).first();

      const classAttr = await watchAction.getAttribute('class') || '';
      const isCurrentlyWatched = classAttr.includes('-on');

      const shouldToggle =
        (!remove && !isCurrentlyWatched) ||
        (remove && isCurrentlyWatched);

      if (!shouldToggle) {
        return;
      }

      await watchAction.click();

      // Wait for DOM to reflect new state
      if (remove) {
        // Wait until "-on" disappears
        await page.waitForSelector(
          `${watchSelector}:not(.-on)`,
          { timeout: 10000 }
        );
      } else {
        // Wait until "-on" appears
        await page.waitForSelector(
          `${watchSelector}.-on`,
          { timeout: 10000 }
        );
      }
    });
  }

  async addToWatchlist(slug, remove = false) {
    return this._performAction(`${this.baseUrl}/film/${slug}/`, async (page) => {
      // Wait a bit for AJAX / React to render
      await page.waitForTimeout(1000);

      // Outer span is stable; locate inner <a> afterwards
      const outerSelector = '.action-large.-watchlist';
      await page.waitForSelector(outerSelector, { timeout: 10000 });

      const watchlistBtn = page.locator(`${outerSelector} a`).first();

      const classAttr = await watchlistBtn.getAttribute('class') || '';
      const isCurrentlyIn = classAttr.includes('-on');

      const shouldToggle = (!remove && !isCurrentlyIn) || (remove && isCurrentlyIn);

      if (!shouldToggle) {
        return;
      }

      await watchlistBtn.click();

      // Wait for the state to toggle reliably
      await page.waitForFunction(
        ({ outerSelector, remove }) => {
          const el = document.querySelector(`${outerSelector} a`);
          if (!el) return false;
          const hasOn = el.classList.contains('-on');
          return remove ? !hasOn : hasOn;
        },
        { outerSelector, remove },
        { timeout: 10000 }
      );
    });
  }

  async toggleLike(slug, reviewId = null, remove = false) {
    const url = `${this.baseUrl}/film/${slug}/`;

    return this._performAction(url, async (page) => {
      const likeTargetSelector = 'span.like-link-target.react-component[data-component-class="LikeComponent"]';
      await page.waitForSelector(likeTargetSelector, { timeout: 10000 });

      const likeTarget = page.locator(likeTargetSelector).first();

      // Evaluate current state
      const isLiked = await likeTarget.evaluate((el) => {
        const inner = el.querySelector('.action.-like');
        return inner && inner.classList.contains('-on');
      });

      const shouldToggle = (!remove && !isLiked) || (remove && isLiked);
      if (!shouldToggle) {
        return;
      }

      // Click the outer container, not inner span.
      await likeTarget.click();

      // Wait for React to update the inner span
      await page.waitForFunction(
        (selector, removeValue) => {
          const el = document.querySelector(selector);
          const inner = el?.querySelector('.action.-like');
          if (!inner) return false;
          return removeValue ? !inner.classList.contains('-on') : inner.classList.contains('-on');
        },
        likeTargetSelector,
        remove,
        { timeout: 5000 }
      );

      await page.waitForTimeout(300); // small buffer for React
    });
  }

  async writeReview(slug, options = {}) {
    return this._performAction(`${this.baseUrl}/film/${slug}/`, async (page) => {
      // Open the review modal.
      // Handles both:
      // 1) direct "Review/Log" trigger on film page
      // 2) "Log again / edit review…" dropdown when film was already logged
      const modalSelector = '#diary-entry-form-modal.show';
      const isModalOpen = async () => (await page.locator(modalSelector).count()) > 0;

      const directModalTrigger = page.locator(
        'button[data-bs-target="#diary-entry-form-modal"], button[data-bs-toggle="modal"][data-bs-target="#diary-entry-form-modal"]'
      );

      if (await directModalTrigger.count()) {
        await directModalTrigger.first().click();
      } else {
        // Already logged state: open menu first, then choose "Review or log again…"
        const relogMenuTrigger = page.locator(
          'button:has-text("Log again"), button:has-text("edit review"), button:has-text("Edit review")'
        ).first();

        if (!(await relogMenuTrigger.count())) {
          throw new Error('Could not find review/log trigger on film page.');
        }

        await relogMenuTrigger.click();

        const reviewAgainOption = page.locator(
          'button[data-bs-target="#diary-entry-form-modal"]:has-text("Review or log again"), button:has-text("Review or log again")'
        ).first();

        await reviewAgainOption.waitFor({ state: 'visible', timeout: 10000 });
        await reviewAgainOption.click();
      }

      if (!(await isModalOpen())) {
        await page.waitForSelector(modalSelector, { state: 'visible', timeout: 10000 });
      }

      // Fill in review text
      if (options.reviewText) {
        await page.fill('#diary-entry-form-modal textarea', options.reviewText);
      }

      // Set rating (0–5 stars, support half stars)
      if (typeof options.rating === 'number') {
        const rate = Math.round(options.rating * 2); // convert 0-5 -> 0-10

        const modal = page.locator('#diary-entry-form-modal.show');
        await modal.waitFor({ state: 'visible' });

        const slider = modal.locator('.rateit-range').first();
        await slider.waitFor({ state: 'visible' });

        const box = await slider.boundingBox();
        if (!box) {
          throw new Error('Unable to set rating: rating control is not visible.');
        }

        const clickX = (rate / 10) * box.width;

        await slider.click({
          position: {
            x: clickX,
            y: box.height / 2
          }
        });

      }

      // Toggle "Like" checkbox
      if (typeof options.like === 'boolean') {
        const modal = page.locator('#diary-entry-form-modal.show');

        // Wait for the like fieldgroup/label to be visible
        const likeLabel = modal.locator('label.option-label.-like');
        await likeLabel.waitFor({ state: 'visible', timeout: 10000 });

        const likeCheckbox = likeLabel.locator('input[name="liked"]');
        const likeSubstitute = likeLabel.locator('i.substitute');

        const isLiked = await likeCheckbox.isChecked();
        if (isLiked !== options.like) {
          await likeSubstitute.click();
        }
      }

      // Toggle "Contains Spoilers"
      if (typeof options.containsSpoilers === 'boolean') {
        const modal = page.locator('#diary-entry-form-modal.show');
        const spoilersCheckbox = modal.locator('#frm-spoilers');

        await spoilersCheckbox.evaluate((el, value) => {
          el.checked = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, options.containsSpoilers);
      }

      // Toggle "I've watched this before / rewatch"
      if (typeof options.seenBefore === 'boolean') {
        const modal = page.locator('#diary-entry-form-modal.show');

        // Wait for the rewatch fieldgroup to be visible first
        const rewatchGroup = modal.locator('.js-fieldgroup-rewatch');
        await rewatchGroup.waitFor({ state: 'visible', timeout: 10000 });

        const rewatchCheckbox = rewatchGroup.locator('input#frm-rewatch');
        const rewatchSubstitute = rewatchGroup.locator('i.substitute');

        const isChecked = await rewatchCheckbox.isChecked();
        if (isChecked !== options.seenBefore) {
          await rewatchSubstitute.click();
        }
      }

      // Submit the review
      await page.waitForTimeout(1000);
      const submitButton = page.locator('#diary-entry-form-modal button[type="submit"]');
      await Promise.all([
        page.waitForSelector('#diary-entry-form-modal', { state: 'hidden', timeout: 10000 }),
        submitButton.click(),
      ]);
      return true;
    });
  }

  async writeReviewByTitle(title, options = {}) {
    await this.ensureLoggedIn();

    const { year, ...reviewOptions } = options;
    const results = await this.search(title, 'films', { limit: 10 });

    if (!results?.items?.length) {
      throw new Error(`No search results found for "${title}"`);
    }

    let candidates = results.items;

    // If year provided, filter by year first.
    if (year) {
      const yearMatches = candidates.filter((item) => item.year === year);

      if (yearMatches.length === 0) {
        throw new Error(
          `No "${title}" found from ${year}. Found: ` +
          candidates.map((f) => `${f.title} (${f.year ?? 'unknown'})`).join(', ')
        );
      }

      candidates = yearMatches;
    }

    const movie = pickBestTitleMatch(title, candidates);
    if (!movie?.slug) {
      throw new Error(`Invalid movie selection for "${title}"`);
    }

    return this.writeReview(movie.slug, reviewOptions);
  }

  async addToList(filmSlug, listTitle) {
    return this._performAction(`${this.baseUrl}/film/${filmSlug}/`, async (page) => {
      // Open modal
      await page.click('.menu-item-add-to-list');

      // Wait for the modal form
      await page.waitForSelector('form[action="/s/add-film-to-list"]', { timeout: 10000 });

      // Wait for the public list filter input
      await page.waitForSelector('#list-filter-public', { timeout: 5000 });

      // Type list title into filter
      await page.fill('#list-filter-public', listTitle);

      // Small delay for filtering to apply
      await page.waitForTimeout(800);

      // Wait for list item to appear
      await page.waitForSelector('.js-list-filter-item', { timeout: 5000 });

      // Find the label containing the visible list name
      const listOption = page.locator(
        `.js-list-filter-item:has(.js-list-filter-data:text-is("${listTitle}"))`
      ).first();

      if (!(await listOption.count())) {
        throw new Error(`List not found: ${listTitle}`);
      }

      // Check the checkbox inside the label
      const checkbox = listOption.locator('input[type="checkbox"]');
      await checkbox.check();

      // Wait for submit button to become enabled
      const submitButton = page.locator('.js-add-to-list-submit');
      await submitButton.waitFor({ state: 'visible' });

      await page.waitForFunction(
        (btn) => !btn.disabled,
        await submitButton.elementHandle()
      );

      // Submit normally (let Letterboxd handle CSRF etc.)
      await Promise.all([
        page.waitForResponse((resp) =>
          resp.url().includes('/s/add-film-to-list') && resp.status() === 200
        ),
        submitButton.click(),
      ]);
    });
  }

  async createList(
    title,
    description,
    {
      visibility = 'Public', // 'Public' | 'Anyone' | 'Friends' | 'You'
      ranked = false,
      filmSlug = null,
    } = {}
  ) {
    return this._performAction(`${this.baseUrl}/list/new/`, async (page) => {
      await page.goto(`${this.baseUrl}/list/new/`, {
        waitUntil: 'domcontentloaded',
      });

      // Wait for name field (real selector from your HTML)
      await page.waitForSelector('input[name="name"]');

      // Fill basic info
      await page.fill('input[name="name"]', title);
      await page.fill('textarea[name="notes"]', description);

      // Set visibility
      await page.selectOption('select[name="sharing"]', visibility);

      // Set ranked toggle
      if (ranked) {
        await page.check('input[name="numberedList"]');
      }

      // Optional: Add film during creation
      if (filmSlug) {
        const filmTitle = filmSlug
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());

        const input = page.locator('#frm-list-film-name');

        // Focus explicitly.
        await input.click();

        // Clear field.
        await input.fill('');

        // Type slowly.
        await input.type(filmTitle, { delay: 120 });

        // Wait for autocomplete list to render.
        await page.waitForSelector('ul li.ac_even, ul li.ac_odd', {
          timeout: 5000,
        });

        // Small explicit pause to stabilize older autocomplete behavior.
        await page.waitForTimeout(1000);

        const firstItem = page.locator('ul li.ac_even, ul li.ac_odd').first();

        // Hover so the suggestion receives focus class.
        await firstItem.hover();

        // Use mouse down/up for compatibility with legacy handlers.
        const box = await firstItem.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(100);
        await page.mouse.up();

        // Wait for film entry to be injected into DOM.
        await page.waitForSelector('.film-list-entry, .poster-container', {
          timeout: 5000,
        });
      }

      // Click Save (JS handler)
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.click('#list-edit-save'),
        page.waitForTimeout(1000),
      ]);
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
