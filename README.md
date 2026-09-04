# floatskivers

Browser extension prototype for turning AllRecipes pages into a FairPrice
shopping list.

## FairPrice cart flow

After building a shopping list, the extension automatically searches every
ingredient and selects the closest in-stock FairPrice result. Each ingredient
shows the selected product link, pack size, price, planned pack count, and a
link to the full search results for review. Choose **Add to FairPrice Cart**
at the bottom to write all matched products to FairPrice's guest `cart`
local-storage entry in one batch and open the cart for final review.

The extension uses the site's own search-page product payload, not an
undocumented product API. When both recipe and pack sizes are weight-based,
it calculates enough packs to cover the recipe amount; otherwise it defaults
to one pack so unit conversions are not guessed.

Reload the unpacked extension after pulling the FairPrice integration so
Chrome registers the new background worker and FairPrice host permission.
