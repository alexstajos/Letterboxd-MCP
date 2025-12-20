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

  async search(query, type = 'films') {
    const url = `${this.baseUrl}/search/${type}/${encodeURIComponent(query)}/`;
    const html = await this.getPageSource(url);
    const $ = cheerio.load(html);
    const results = [];

    $('.results li').each((i, el) => {
      const title = $(el).find('.film-title-wrapper a, .name').text().trim();
      const link = $(el).find('a').attr('href');
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

    const title = $('h1.filmtitle').text().trim();
    const year = $('.releaseyear a').text().trim();
    const director = $('.director a').map((i, el) => $(el).text().trim()).get().join(', ');
    const synopsis = $('.truncate p').text().trim() || $('.review-body-text').text().trim();
    const rating = $('.average-rating a').text().trim();

    return { title, year, director, synopsis, rating, url };
  }

  async getList(user, listSlug) {
    const url = `${this.baseUrl}/${user}/list/${listSlug}/`;
    const html = await this.getPageSource(url);
    const $ = cheerio.load(html);
    const films = [];

    $('.poster-container').each((i, el) => {
      const title = $(el).find('img').attr('alt');
      const slug = $(el).find('.poster').attr('data-film-slug');
      films.push({ title, slug });
    });

    return films;
  }

  async getReview(username, filmSlug) {
    const url = `${this.baseUrl}/${username}/film/${filmSlug}/`;
    const html = await this.getPageSource(url);
    const $ = cheerio.load(html);
    const reviewText = $('.review-body-text').text().trim();
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

  async getMemberWatchlist(username) {
    const url = `${this.baseUrl}/${username}/watchlist/`;
    const html = await this.getPageSource(url);
    const $ = cheerio.load(html);
    const films = [];

    $('.poster-container').each((i, el) => {
      const title = $(el).find('img').attr('alt');
      const slug = $(el).find('.poster').attr('data-film-slug');
      films.push({ title, slug });
    });

    return films;
  }

  async getMemberFilms(username) {
    const url = `${this.baseUrl}/${username}/films/`;
    const html = await this.getPageSource(url);
    const $ = cheerio.load(html);
    const films = [];

    $('.poster-container').each((i, el) => {
      const title = $(el).find('img').attr('alt');
      const slug = $(el).find('.poster').attr('data-film-slug');
      films.push({ title, slug });
    });

    return films;
  }

  async getMemberRatings(username) {
    const url = `${this.baseUrl}/${username}/films/ratings/`;
    const html = await this.getPageSource(url);
    const $ = cheerio.load(html);
    const ratings = [];

    $('.poster-container').each((i, el) => {
      const title = $(el).find('img').attr('alt');
      const slug = $(el).find('.poster').attr('data-film-slug');
      const rating = $(el).parent().find('.poster-viewingdata .rating').text().trim();
      ratings.push({ title, slug, rating });
    });

    return ratings;
  }

  async getMemberReviews(username) {
    const url = `${this.baseUrl}/${username}/films/reviews/`;
    const html = await this.getPageSource(url);
    const $ = cheerio.load(html);
    const reviews = [];

    $('.film-detail').each((i, el) => {
      const title = $(el).find('.film-detail-content h2 a').text().trim();
      const slug = $(el).find('.film-detail-content h2 a').attr('href').split('/').filter(Boolean).pop();
      const rating = $(el).find('.rating').text().trim();
      const summary = $(el).find('.body-text').text().trim();
      reviews.push({ title, slug, rating, summary });
    });

    return reviews;
  }

  async getMemberDiary(username) {
    const url = `${this.baseUrl}/${username}/diary/`;
    const html = await this.getPageSource(url);
    const $ = cheerio.load(html);
    const diaryEntries = [];

    $('.diary-entry-row').each((i, el) => {
      const date = $(el).find('.td-calendar .day').text().trim() + ' ' + $(el).find('.td-calendar .month').text().trim();
      const title = $(el).find('.td-film-details h3 a').text().trim();
      const rating = $(el).find('.td-rating .rating').text().trim();
      diaryEntries.push({ date, title, rating });
    });

    return diaryEntries;
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
