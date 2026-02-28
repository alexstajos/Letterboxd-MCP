require('dotenv').config({ quiet: true });
const { test, after, run } = require('node:test');
const assert = require('node:assert/strict');
const LetterboxdClient = require('../letterboxd');
const {
  TEST_USERNAME,
  assertPagedResult,
  assertFilmItemShape,
} = require('./helpers');

if (!process.env.LETTERBOXD_USERNAME || !process.env.LETTERBOXD_PASSWORD) {
  process.env.LETTERBOXD_LOGIN_FOR_READS = 'false';
}

const client = new LetterboxdClient();

after(async () => {
  await client.close();
});

test('search films returns paged results with slugs', async () => {
  const result = await client.search('inception', 'films', { limit: 5 });
  assertPagedResult(result);
  assert.ok(result.items.length > 0, 'Expected at least one search result');

  const first = result.items[0];
  assertFilmItemShape(first);
  assert.ok(first.url && typeof first.url === 'string', 'Expected result URL');
});

test('get_film returns core film metadata', async () => {
  const search = await client.search('inception', 'films', { limit: 1 });
  assert.ok(search.items.length > 0, 'Expected a film to test getFilm');

  const film = await client.getFilm(search.items[0].slug);
  assert.ok(film && typeof film === 'object', 'Expected film object');
  assert.equal(typeof film.title, 'string');
  assert.ok(film.title.length > 0, 'Expected non-empty film title');
  assert.ok(film.url.includes('/film/'), 'Expected Letterboxd film URL');
});

test('get_current_user returns auth state object', async () => {
  const me = await client.getCurrentUser();
  assert.ok(me && typeof me === 'object', 'Expected current-user object');
  assert.equal(typeof me.loggedIn, 'boolean');
});

test('member read tools return valid structures', async (t) => {
  if (!TEST_USERNAME) {
    t.skip('Set LETTERBOXD_TEST_USERNAME (or LETTERBOXD_USERNAME) to run member read tests.');
    return;
  }

  const member = await client.getMember(TEST_USERNAME);
  assert.ok(member && typeof member === 'object');
  assert.equal(typeof member.username, 'string');

  const watchlist = await client.getMemberWatchlist(TEST_USERNAME, { limit: 5 });
  assertPagedResult(watchlist);
  if (watchlist.items[0]) assertFilmItemShape(watchlist.items[0]);

  const films = await client.getMemberFilms(TEST_USERNAME, { limit: 5 });
  assertPagedResult(films);
  if (films.items[0]) assertFilmItemShape(films.items[0]);

  const ratings = await client.getMemberRatings(TEST_USERNAME, { limit: 5 });
  assertPagedResult(ratings);

  const diary = await client.getMemberDiary(TEST_USERNAME, { limit: 5 });
  assertPagedResult(diary);

  const reviews = await client.getMemberReviews(TEST_USERNAME, { limit: 5 });
  assertPagedResult(reviews);

  const lists = await client.getLists(TEST_USERNAME, { limit: 5 });
  assertPagedResult(lists);

  const pinned = await client.getMemberPinned(TEST_USERNAME);
  assert.ok(pinned && typeof pinned === 'object');
  assert.ok(Array.isArray(pinned.items), 'Expected pinned items array');
});

test('get_review can fetch a concrete review when available', async (t) => {
  if (!TEST_USERNAME) {
    t.skip('Set LETTERBOXD_TEST_USERNAME (or LETTERBOXD_USERNAME) to run review fetch test.');
    return;
  }

  const reviews = await client.getMemberReviews(TEST_USERNAME, { limit: 10 });
  assertPagedResult(reviews);

  const sample = reviews.items.find((item) => item.slug);
  if (!sample) {
    t.skip(`No reviews found for ${TEST_USERNAME}.`);
    return;
  }

  const detail = await client.getReview(TEST_USERNAME, sample.slug, sample.reviewId || undefined);
  assert.ok(detail && typeof detail === 'object');
  assert.equal(typeof detail.filmSlug, 'string');
  assert.ok(detail.url.includes('/film/'), 'Expected review URL');
});

run();
