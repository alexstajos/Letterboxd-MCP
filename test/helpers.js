const assert = require('node:assert/strict');

const TEST_USERNAME = process.env.LETTERBOXD_TEST_USERNAME || process.env.LETTERBOXD_USERNAME || '';
const TEST_FILM_SLUG = process.env.LETTERBOXD_TEST_FILM_SLUG || 'sing-sing-2023';
const TEST_SECOND_FILM_SLUG = process.env.LETTERBOXD_TEST_SECOND_FILM_SLUG || 'west-side-story-2021';
const TEST_LIST_TITLE = process.env.LETTERBOXD_TEST_LIST_TITLE || 'MCP Automated Test List';
const TEST_REVIEW_FILM_SLUG = process.env.LETTERBOXD_TEST_REVIEW_FILM_SLUG || TEST_FILM_SLUG;

function hasCredentials() {
  return Boolean(process.env.LETTERBOXD_USERNAME && process.env.LETTERBOXD_PASSWORD);
}

function assertPagedResult(result) {
  assert.ok(result && typeof result === 'object', 'Expected an object result');
  assert.ok(Array.isArray(result.items), 'Expected an items array');
}

function assertFilmItemShape(item) {
  assert.ok(item && typeof item === 'object', 'Expected item object');
  assert.equal(typeof item.title, 'string', 'Expected title to be a string');
  assert.equal(typeof item.slug, 'string', 'Expected slug to be a string');
}

module.exports = {
  TEST_USERNAME,
  TEST_FILM_SLUG,
  TEST_SECOND_FILM_SLUG,
  TEST_LIST_TITLE,
  TEST_REVIEW_FILM_SLUG,
  hasCredentials,
  assertPagedResult,
  assertFilmItemShape,
};
