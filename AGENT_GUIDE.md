# Agent Instructions & Prompt Recipes

This guide provides specialized instructions and "recipes" for AI agents (like Claude, ChatGPT, or Gemini) to effectively use the Letterboxd MCP tools.

## Letterboxd Prompt Recipes

### 1) Find one specific review
```text
Get user `FilmFanBob`'s review for the film `Sing Sing` on Letterboxd.
Use MCP tools only.
Steps:
1) Search films to resolve the exact slug.
2) If multiple matches exist, pick the 2023 film.
3) Fetch `FilmFanBob` review details for that film.
Return: film title, film slug, username, rating, date, full review text, review URL.
If no review exists, return "no review found" with the resolved film slug.
```

### 2) Top-N ranked slice with enrichment
```text
Get `FilmFanBob`'s top 5 highest-rated films from release year 1995 on Letterboxd.
Use MCP tools only.
Steps:
1) Fetch all pages of `FilmFanBob` ratings.
2) Sort by rating descending.
3) Resolve release year for candidates from film details.
4) Filter to year `1995`.
Return top 5 with: title, slug, rating, year.
Tie-breaker: preserve original order from the ratings list.
```

### 3) List management (mutating)
```text
Using MCP tools only, add film `<film_slug>` to my list `<list title>`.
Steps:
1) Ensure authenticated user is available.
2) Add the film to the list.
3) Read back list details to verify membership.
Return: success flag, list title, list slug, and whether the film is present after mutation.
```

---

## Output Format Guidance

For easy downstream use, ask for compact structured output:

```text
Return JSON with this schema:
{
  "query": string,
  "items": [
    { "title": string, "slug": string, "rating": string, "year": number }
  ],
  "notes": string
}
```

---

## Disambiguation: Ratings vs Lists

When a prompt says "top films" for a user, force source disambiguation.

**Rule:**
- If user asks for "top" and does not explicitly say "list", default to **personal ratings activity**.
- Explicitly exclude curated lists unless requested.

**Recommended clause to include in prompts:**
> "Use the member's personal ratings activity as the source, not any Letterboxd lists."

**Example (1991):**
```text
Get `FilmFanBob`'s top 5 highest-rated films released in `1991` from FilmFanBob's personal ratings activity, not from any Letterboxd lists.
Use MCP tools only.
Steps:
1) Fetch all pages of `FilmFanBob` ratings.
2) Resolve each film's release year from film details.
3) Filter to year `1991`.
4) Sort by rating descending.
Tie-breaker: preserve original order from the ratings feed.
Return: title, slug, rating, year, source=`member_ratings`.
```

---

## Free-Form Review Parsing

Do not require users to provide a rigid review template. When a user says `post review:` followed by free-form text, apply the following logic:

1.  **Extract rating** from the last `<number>/5` token.
2.  **Infer title** using early-text heuristics:
    *   Leading phrase before first opinion-heavy sentence.
    *   Patterns like `Title - ...`, `Title. ...`, `Title: ...`.
3.  **Identify body**: Treat remaining prose as review body.
4.  **Disambiguate**: If multiple title candidates are plausible, search and choose the best match, then confirm.
5.  **Clarify**: If confidence is low for title or rating, ask a short clarifying follow-up.

### Example: Accepted Free-Form Input
> `post review: Black Bag. I don't really know if Soderbergh really works for me... 2/5`

**Expected Extraction:**
- **title**: `Black Bag`
- **reviewText**: `I don't really know if Soderbergh really works for me...`
- **rating**: `2`
- **like**: `false` (Rating < 3.5)

---

## Post Review Input Contract

Use this contract when the user issues a `post review:` command.

### Like Policy
- Rating `>= 4.0` → **Like**
- Rating `< 3.5` → **No Like**
- Rating `== 3.5` → **Ask user** whether to like if not explicitly specified.

### Pre-Post Confirmation Requirement
1.  After resolving the film on Letterboxd, **always confirm** with the user before posting.
2.  Confirmation **must** include: title, year, parsed review text, rating, and like state.
3.  **Only post** after explicit user confirmation.

### Example: Detailed Parsing
**Input:**
> `post review: Materialists -  A quietly captivating film that left a strong impression on me. The performances feel authentic and emotionally resonant, making it easy to stay invested throughout. It’s thoughtful, understated, and lingers in your mind after the credits roll. 3.5/5`

**Extraction:**
- **title**: `Materialists`
- **reviewText**: `A quietly captivating film that left...`
- **rating**: `3.5`
- **like**: (Ask user)

---

## Prompt Anti-Patterns
- "Find something about X" (too vague).
- Missing tie-break rule.
- Missing year/version disambiguation.
- Missing output schema.
- Asking for ranking without stating sort metric and direction.

## Quick Builder Checklist
Before sending your prompt, confirm:
- [ ] Goal is singular and explicit.
- [ ] MCP-only constraint included.
- [ ] Steps are numbered.
- [ ] Filters are explicit.
- [ ] Sort + tie-break defined.
- [ ] Output fields defined.
- [ ] Fallback behavior defined.
