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

Cart additions run sequentially in one background FairPrice tab. For each
product the extension waits for FairPrice's native **Add to cart** control,
clicks it, and verifies that the guest-cart quantity changed. If the native
control is missing or does not reach the requested quantity, only that
product falls back to the compatible local-storage cart entry. The tab moves
to the next product even if one addition fails, then opens the cart when the
whole queue finishes.

The popup shows the current product and cart stage, an animated progress bar,
and a native/fallback/failed state beside each match. Product processing starts
when the document commits instead of waiting for nonessential images and
analytics, and the native timeout is kept short before using the fallback.

The extension uses the site's own search-page product payload, not an
undocumented product API. When both recipe and pack sizes are weight-based,
it calculates enough packs to cover the recipe amount; otherwise it defaults
to one pack so unit conversions are not guessed.

Reload the unpacked extension after pulling the FairPrice integration so
Chrome registers the new background worker and FairPrice host permission.
