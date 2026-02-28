require('dotenv').config({ quiet: true });
const { test, after, run } = require('node:test');
const assert = require('node:assert/strict');
const LetterboxdClient = require('../letterboxd');
const {
  TEST_FILM_SLUG,
  TEST_SECOND_FILM_SLUG,
  TEST_LIST_TITLE,
  TEST_REVIEW_FILM_SLUG,
  hasCredentials,
} = require('./helpers');

const RUN_MUTATING = process.env.RUN_MUTATING_TESTS === 'true';
const RUN_REVIEW_DOUBLE_POST = process.env.RUN_REVIEW_DOUBLE_POST_TEST === 'true';
const client = new LetterboxdClient();
let resolvedList = null;

after(async () => {
  await client.close();
});

test('mutating suite is explicitly enabled and authenticated', async (t) => {
  if (!RUN_MUTATING) {
    t.skip('Set RUN_MUTATING_TESTS=true to run mutating tests.');
    return;
  }

  if (!hasCredentials()) {
    t.skip('Set LETTERBOXD_USERNAME and LETTERBOXD_PASSWORD to run mutating tests.');
    return;
  }

  await client.ensureLoggedIn();
  const current = await client.getCurrentUser();
  assert.equal(current.loggedIn, true, 'Expected authenticated session');
  assert.ok(current.username, 'Expected username after login');
});

test('ensure a reusable test list exists', async (t) => {
  if (!RUN_MUTATING || !hasCredentials()) {
    t.skip('Mutating tests are disabled.');
    return;
  }

  await client.ensureLoggedIn();
  const username = client.username;
  assert.ok(username, 'Expected username after login');

  const allLists = await client.getAllLists(username);
  const existing = allLists.find((list) => (list.title || '').trim() === TEST_LIST_TITLE);

  if (existing) {
    resolvedList = existing;
    return;
  }

  await client.createList(TEST_LIST_TITLE, 'List used by automated MCP mutating tests.', {
    visibility: 'Public',
    ranked: false,
    filmSlug: TEST_FILM_SLUG,
  });

  const refreshed = await client.getAllLists(username);
  resolvedList = refreshed.find((list) => (list.title || '').trim() === TEST_LIST_TITLE) || null;
  assert.ok(resolvedList, `Expected list "${TEST_LIST_TITLE}" to exist after creation`);
});

test('add_to_list adds the second film into test list', async (t) => {
  if (!RUN_MUTATING || !hasCredentials()) {
    t.skip('Mutating tests are disabled.');
    return;
  }

  if (!resolvedList) {
    t.skip('No resolved test list from previous step.');
    return;
  }

  await client.addToList(TEST_SECOND_FILM_SLUG, TEST_LIST_TITLE);

  const username = client.username;
  const listData = await client.getList(username, resolvedList.slug);
  assert.ok(Array.isArray(listData.items), 'Expected list items');

  const hasFilm = listData.items.some((item) => item.slug === TEST_SECOND_FILM_SLUG);
  assert.equal(hasFilm, true, `Expected "${TEST_SECOND_FILM_SLUG}" to be present in test list`);
});

test('watchlist toggle is reversible for test film', async (t) => {
  if (!RUN_MUTATING || !hasCredentials()) {
    t.skip('Mutating tests are disabled.');
    return;
  }

  const added = await client.addToWatchlist(TEST_FILM_SLUG, false);
  assert.equal(added, true, 'Expected addToWatchlist to succeed');

  const removed = await client.addToWatchlist(TEST_FILM_SLUG, true);
  assert.equal(removed, true, 'Expected addToWatchlist(remove=true) to succeed');
});

test('like toggle is reversible for test film', async (t) => {
  if (!RUN_MUTATING || !hasCredentials()) {
    t.skip('Mutating tests are disabled.');
    return;
  }

  const liked = await client.toggleLike(TEST_FILM_SLUG, null, false);
  assert.equal(liked, true, 'Expected like action to succeed');

  const unliked = await client.toggleLike(TEST_FILM_SLUG, null, true);
  assert.equal(unliked, true, 'Expected unlike action to succeed');
});

test('write_review can post twice for same film (already-logged path)', async (t) => {
  if (!RUN_MUTATING || !hasCredentials()) {
    t.skip('Mutating tests are disabled.');
    return;
  }

  if (!RUN_REVIEW_DOUBLE_POST) {
    t.skip('Set RUN_REVIEW_DOUBLE_POST_TEST=true to run double-post review test.');
    return;
  }

  const stamp = new Date().toISOString();
  const firstText = `Automated MCP review pass 1 (${stamp})`;
  const secondText = `Automated MCP review pass 2 (${stamp})`;

  const first = await client.writeReview(TEST_REVIEW_FILM_SLUG, {
    reviewText: firstText,
    rating: 3,
    like: false,
  });
  assert.equal(first, true, 'Expected first review post to succeed');

  const second = await client.writeReview(TEST_REVIEW_FILM_SLUG, {
    reviewText: secondText,
    rating: 3,
    like: false,
  });
  assert.equal(second, true, 'Expected second review post to succeed');
});

run();
