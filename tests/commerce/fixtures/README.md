Commerce response fixtures.

- `serpapi-*.json`, `ebay-*.json`: doc-shaped (MOCKED). They follow the public SerpAPI and
  eBay Browse response schemas; they are not recordings of live calls.
- `searchapi-amazon-search.json`, `searchapi-amazon-product.json`,
  `searchapi-google-shopping.json`: recorded from live SearchApi.io calls on 2026-10-12
  (engines `amazon_search`, `amazon_product`, `google_shopping`), trimmed to the first
  results. The API key was sent only as an Authorization header and appears nowhere in
  these files.
- `crossmint-staging-create-500.json`: recorded verbatim from a Crossmint staging
  `POST /api/2022-06-09/orders` for `amazon:B01GGKZ1VA` on 2026-10-12. Crossmint's own
  Amazon Business lookup returned 403 upstream.
- The Crossmint order objects used in `crossmint-checkout.test.ts` are built in the
  test from the documented OrderObject schema (Create Order / Get Order API reference).
  Staging has not yet returned a priced Amazon order, so no recording of one exists.

Live evidence is written under bounty-evidence/commerce/.
