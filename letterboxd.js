const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const axios = require('axios');

puppeteer.use(StealthPlugin());

class LetterboxdClient {
  constructor() {
    this.browser = null;
    this.page = null;
    this.baseUrl = 'https://letterboxd.com';
    this.cookies = null;
    this.username = null;
  }

  async init() {
    if (this.browser) return;
    this.browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    this.page = await this.browser.newPage();
  }

  async login(username, password) {
    if (!this.page) await this.init();
    this.username = username;
    
    await this.page.goto(`${this.baseUrl}/signin/`);
    await this.page.type('#username', username);
    await this.page.type('#password', password);
    await Promise.all([
      this.page.click('.button.-primary.button-signin'),
      this.page.waitForNavigation({ waitUntil: 'networkidle0' })
    ]);

    const error = await this.page.$('.message.-error');
    if (error) {
      const text = await this.page.evaluate(el => el.textContent, error);
      throw new Error(`Login failed: ${text.trim()}`);
    }

    this.cookies = await this.page.cookies();
    return true;
  }

  async getPageSource(url) {
    if (!this.page) await this.init();
    if (this.cookies) {
      await this.page.setCookie(...this.cookies);
    }
    await this.page.goto(url, { waitUntil: 'networkidle0' });
    return await this.page.content();
  }

  async _scrapePagedItems(initialUrl, scraperFunc, maxPages = Infinity) {
    let allItems = [];
    let currentUrl = initialUrl;
    let hasNextPage = true;
    let pageCount = 0;

    while (hasNextPage && pageCount < maxPages) {
      const html = await this.getPageSource(currentUrl);
      const $ = cheerio.load(html);
      
      const pageItems = scraperFunc($);
      allItems = allItems.concat(pageItems);
      pageCount++;

      const nextLink = $('.paginate-next, .next').filter('a').first().attr('href');
      if (nextLink) {
        currentUrl = nextLink.startsWith('http') ? nextLink : `${this.baseUrl}${nextLink}`;
      } else {
        hasNextPage = false;
      }
    }

    return allItems;
  }

  async search(query, type = 'films') {
    const url = `${this.baseUrl}/search/${type}/${encodeURIComponent(query)}/`;
    const html = await this.getPageSource(url);
    const $ = cheerio.load(html);
    const results = [];

    $('.results li').each((i, el) => {
      const titleElement = $(el).find('.film-title-wrapper a, .name a').first();
      const title = titleElement.text().trim() || $(el).find('.name').text().trim();
      const link = titleElement.attr('href') || $(el).find('a').attr('href');
      if (title && link) {
        results.push({ title, url: `${this.baseUrl}${link}`, slug: link.split('/').filter(Boolean).pop() });
      }
    });

    return results;
  }

  async getFilm(slug) {
    const url = `${this.baseUrl}/film/${slug}/`;
    const html = await this.getPageSource(url);
    const $ = cheerio.load(html);

    let filmData = {};
    const jsonLd = $('script[type="application/ld+json"]').html();
    if (jsonLd) {
        try {
            // Clean up CDATA if present
            const cleanJson = jsonLd.replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\//, '').replace(/\/\*\s*\]\]>\s*\*\/\s*$/, '');
            const parsed = JSON.parse(cleanJson);
            filmData = {
                title: parsed.name,
                year: parsed.releasedEvent && parsed.releasedEvent[0] ? parsed.releasedEvent[0].startDate : '',
                director: parsed.director ? parsed.director.map(d => d.name).join(', ') : '',
                rating: parsed.aggregateRating ? parsed.aggregateRating.ratingValue : '',
                genre: parsed.genre ? parsed.genre.join(', ') : '',
            };
        } catch (e) {
            console.error('Failed to parse JSON-LD:', e.message);
        }
    }

    const synopsis = $('.truncate p').text().trim() || $('.review-body-text').first().text().trim() || $('.body-text').first().text().trim();

    return { 
        title: filmData.title || $('.headline-1').text().trim(), 
        year: filmData.year || $('.releaseyear a').text().trim(), 
        director: filmData.director || $('.director a').map((i, el) => $(el).text().trim()).get().join(', '), 
        synopsis, 
        rating: filmData.rating || $('.average-rating a').text().trim(),
        genre: filmData.genre,
        url 
    };
  }

  async getList(user, listSlug, limit = Infinity) {
    const url = `${this.baseUrl}/${user}/list/${listSlug}/`;
    const maxPages = limit === Infinity ? Infinity : Math.ceil(limit / 100); // Lists can have up to 100 per page or more
    const items = await this._scrapePagedItems(url, ($) => {
      const pageFilms = [];
      $('.poster-grid .griditem, .poster-container, .poster-list .posteritem').each((i, el) => {
        const imgAlt = $(el).find('img').attr('alt') || '';
        const title = imgAlt.replace(/^Poster for /, '');
        const slug = $(el).find('[data-item-slug]').attr('data-item-slug') || $(el).find('.poster').attr('data-film-slug');
        if (title && slug) {
          pageFilms.push({ title, slug });
        }
      });
      return pageFilms;
    }, maxPages);
    return limit === Infinity ? items : items.slice(0, limit);
  }

  async getReview(username, filmSlug) {
    const url = `${this.baseUrl}/${username}/film/${filmSlug}/`;
    const html = await this.getPageSource(url);
    const $ = cheerio.load(html);
    const reviewText = $('.body-text').text().trim();
    return { username, filmSlug, reviewText };
  }

  async getMember(username) {
    const url = `${this.baseUrl}/${username}/`;
    const html = await this.getPageSource(url);
    const $ = cheerio.load(html);

    const bio = $('.bio p').text().trim();
    const stats = {};
    $('.profile-stats a').each((i, el) => {
        const label = $(el).find('.definition').text().trim();
        const value = $(el).find('.value').text().trim();
        if (label) stats[label] = value;
    });

    return { username, bio, stats, url };
  }

  async getMemberWatchlist(username, limit = Infinity) {
    const url = `${this.baseUrl}/${username}/watchlist/`;
    const maxPages = limit === Infinity ? Infinity : Math.ceil(limit / 72);
    const items = await this._scrapePagedItems(url, ($) => {
      const pageFilms = [];
      $('.poster-grid .griditem, .poster-container, .poster-list .posteritem').each((i, el) => {
        const imgAlt = $(el).find('img').attr('alt') || '';
        const title = imgAlt.replace(/^Poster for /, '');
        const slug = $(el).find('[data-item-slug]').attr('data-item-slug') || $(el).find('.poster').attr('data-film-slug');
        if (title && slug) {
          pageFilms.push({ title, slug });
        }
      });
      return pageFilms;
    }, maxPages);
    return limit === Infinity ? items : items.slice(0, limit);
  }

  async getMemberFilms(username, limit = Infinity) {
    const url = `${this.baseUrl}/${username}/films/`;
    const maxPages = limit === Infinity ? Infinity : Math.ceil(limit / 72);
    const items = await this._scrapePagedItems(url, ($) => {
      const pageFilms = [];
      $('.poster-grid .griditem, .poster-container, .poster-list .posteritem').each((i, el) => {
        const imgAlt = $(el).find('img').attr('alt') || '';
        const title = imgAlt.replace(/^Poster for /, '');
        const slug = $(el).find('[data-item-slug]').attr('data-item-slug') || $(el).find('.poster').attr('data-film-slug');
        if (title && slug) {
          pageFilms.push({ title, slug });
        }
      });
      return pageFilms;
    }, maxPages);
    return limit === Infinity ? items : items.slice(0, limit);
  }

  async getMemberRatings(username, limit = Infinity) {
    const url = `${this.baseUrl}/${username}/films/ratings/`;
    const maxPages = limit === Infinity ? Infinity : Math.ceil(limit / 72);
    const items = await this._scrapePagedItems(url, ($) => {
      const pageRatings = [];
      $('.poster-grid .griditem, .poster-container, .poster-list .posteritem').each((i, el) => {
        const imgAlt = $(el).find('img').attr('alt') || '';
        const title = imgAlt.replace(/^Poster for /, '');
        const slug = $(el).find('[data-item-slug]').attr('data-item-slug') || $(el).find('.poster').attr('data-film-slug');
        const rating = $(el).find('.poster-viewingdata .rating').text().trim();
        if (title && slug) {
          pageRatings.push({ title, slug, rating });
        }
      });
      return pageRatings;
    }, maxPages);
    return limit === Infinity ? items : items.slice(0, limit);
  }

  async getMemberReviews(username, limit = Infinity) {
    const url = `${this.baseUrl}/${username}/films/reviews/`;
    const maxPages = limit === Infinity ? Infinity : Math.ceil(limit / 12);
    const items = await this._scrapePagedItems(url, ($) => {
      const pageReviews = [];
      $('.listitem').each((i, el) => {
        const title = $(el).find('.name a').text().trim();
        const slug = $(el).find('.react-component').attr('data-item-slug') || $(el).find('.name a').attr('href')?.split('/').filter(Boolean).pop();
        const rating = $(el).find('.rating').text().trim();
        const summary = $(el).find('.body-text').text().trim();
        if (title && slug) {
          pageReviews.push({ title, slug, rating, summary });
        }
      });
      return pageReviews;
    }, maxPages);
    return limit === Infinity ? items : items.slice(0, limit);
  }

  async getMemberDiary(username, limit = Infinity) {
    const url = `${this.baseUrl}/${username}/diary/`;
    const maxPages = limit === Infinity ? Infinity : Math.ceil(limit / 50);
    const items = await this._scrapePagedItems(url, ($) => {
      const pageEntries = [];
      $('.diary-entry-row').each((i, el) => {
        const date = $(el).find('.td-calendar .day').text().trim() + ' ' + $(el).find('.td-calendar .month').text().trim();
        const title = $(el).find('.td-film-details h3 a').text().trim();
        const rating = $(el).find('.td-rating .rating').text().trim();
        pageEntries.push({ date, title, rating });
      });
      return pageEntries;
    }, maxPages);
    return limit === Infinity ? items : items.slice(0, limit);
  }

  async getCurrentUser() {
    return { username: this.username, loggedIn: !!this.cookies };
  }

  async rateFilm(slug, rating) {
    if (!this.page) await this.init();
    await this.page.goto(`${this.baseUrl}/film/${slug}/`);
    
    // Rating is usually a click on stars. Letterboxd uses a scale of 1-10 (half stars).
    // .star-10 is 5 stars, .star-9 is 4.5 stars, etc.
    const starSelector = `.rate-it .stars .star-${rating}`;
    await this.page.waitForSelector('.rate-it');
    await this.page.click(starSelector);
    return true;
  }

  async addToWatchlist(slug) {
    if (!this.page) await this.init();
    await this.page.goto(`${this.baseUrl}/film/${slug}/`);
    const watchlistButton = '.watchlist-tgl';
    await this.page.waitForSelector(watchlistButton);
    await this.page.click(watchlistButton);
    return true;
  }

  async writeReview(slug, reviewText, rating, containsSpoilers = false) {
    if (!this.page) await this.init();
    await this.page.goto(`${this.baseUrl}/film/${slug}/`);
    
    // Click "Log" or "Review" button
    const logButton = '.action-viewing';
    await this.page.waitForSelector(logButton);
    await this.page.click(logButton);
    
    await this.page.waitForSelector('#field-diary-review');
    await this.page.type('#field-diary-review', reviewText);
    
    if (rating) {
        const starSelector = `.rate-it .stars .star-${rating}`;
        await this.page.click(starSelector);
    }
    
    if (containsSpoilers) {
        await this.page.click('#field-any-spoilers');
    }
    
    await this.page.click('#diary-entry-submit');
    return true;
  }

  async addToList(slug, listSlug) {
    if (!this.page) await this.init();
    // This is often done via the "Add to list" dialog on the film page
    await this.page.goto(`${this.baseUrl}/film/${slug}/`);
    const addToListButton = '.add-to-list';
    await this.page.waitForSelector(addToListButton);
    await this.page.click(addToListButton);
    
    // Wait for the modal and select the list
    // This part is very dynamic and might be tricky with just selectors
    // Usually lists have their own IDs. 
    // For now, let's assume we can find the list by its slug in the modal.
    // A better way might be to find the list ID first.
    
    // Simplified: Letterboxd lists in the modal are often checkboxes.
    // We'll try to find the checkbox related to the listSlug.
    await this.page.waitForSelector('.list-select-item');
    const listFound = await this.page.evaluate((targetSlug) => {
        const items = document.querySelectorAll('.list-select-item');
        for (const item of items) {
            const link = item.querySelector('a');
            if (link && link.href.includes(targetSlug)) {
                item.click();
                return true;
            }
        }
        return false;
    }, listSlug);
    
    return listFound;
  }

  async close() {
    if (this.browser) await this.browser.close();
  }
}

module.exports = LetterboxdClient;
