# floatskivers

Browser extension prototype for turning AllRecipes pages into a FairPrice
shopping list.

## FairPrice cart flow

After building a shopping list, the extension automatically searches every
ingredient and selects the closest in-stock FairPrice result. Each ingredient
shows the selected product link, pack size, price, planned pack count, and a
link to the full search results for review. Choose **Add to FairPrice Cart**
at the bottom to add all matched products through FairPrice's native controls,
use a guest-cart reconciliation fallback where necessary, and open the cart
for final review.

The extension opens every matched product page in background tabs at once.
Before changing the cart, it checks FairPrice's own delivery and account
session. If no address or postal code has been selected, it stops without
touching the cart and opens FairPrice's native location selector. The pending
products are stored temporarily in extension session storage, and adding resumes automatically after the
shopper chooses a location; the extension neither reads nor stores the postal
code itself. This prevents FairPrice from rehydrating an uninitialised session
and clearing the generated cart.

Because Chrome closes the extension popup when the FairPrice tab becomes
active, a floating Recipe Cart progress panel is injected into that tab. It
shows the location handoff, the product currently being added, verification
progress, fallback status, and cart completion while work continues in the
background. During the location handoff, the address field is focused and
highlighted with an animated callout anchored to it so the required action is
immediately obvious.

After the first usable page establishes the initial cart quantities, each page
joins a readiness-driven queue as soon as its native **Add to cart** button is
available; a slow product no longer blocks faster ones. Cart clicks run one at
a time with a brief settle window because concurrent FairPrice tabs can
overwrite the same guest-cart snapshot. Once all attempts settle, the product
tabs are destroyed and a single atomic reconciliation pass fills any missing
product, enforces every requested pack count, and opens the cart.

Both account modes use FairPrice's native **Add to cart** controls. Confirmed
guest sessions may use the local-storage reconciliation fallback after native
attempts finish. Signed-in sessions never receive synthetic guest-cart writes;
their account-backed FairPrice cart remains the sole source of truth.

Weight-based recipe quantities are converted to enough retail packs to cover
the requested weight. Bare counts, whole items, and cans also preserve
quantities greater than one, accounting for multipacks when FairPrice exposes a
piece count in the product's display unit.

Product navigation uses FairPrice's canonical slug directly; the slug already
contains an item number when FairPrice requires one. Ingredient-specific search
normalization and derivative penalties keep whole foods such as baking potatoes
from matching starch or flour. The final reconciliation synchronizes both
`cart` and FairPrice's cached `sellerCart` quantities.

The popup shows the current product and cart stage, an animated progress bar,
and a native/fallback/failed state beside each match. Product documents start
processing when they commit instead of waiting for nonessential images and
analytics.

The extension uses the site's own search-page product payload, not an
undocumented product API. When both recipe and pack sizes are weight-based,
it calculates enough packs to cover the recipe amount; otherwise it defaults
to one pack so unit conversions are not guessed.

Reload the unpacked extension after pulling the FairPrice integration so
Chrome registers the new background worker and FairPrice host permission.
