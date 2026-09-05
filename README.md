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

Native verification races the cart-storage update against FairPrice's visible
Add-button transition, so location-specific fresh-produce variants do not pay a
multi-second storage timeout. Cart matching also recognises FairPrice's internal
ID, client item ID, and canonical slug when a selected store substitutes the
underlying fresh-product record.

Per-product work uses bounded budgets rather than stacked long waits: product
navigation is capped at six seconds, control discovery at 1.8 seconds, and a
single-pack native action at roughly 2.2 seconds. An unresponsive product falls
through to the appropriate recovery path without holding the remaining queue
for around twenty seconds.

For larger shopping lists, at most four reusable FairPrice product tabs are
kept alive. Each worker preloads its next product while a single mutation queue
updates the shared cart, avoiding the CPU, memory, and background-timer
throttling caused by twelve or more simultaneous FairPrice applications.

The latest cart-run state is stored in extension session storage. Closing and
reopening the extension popup restores the current product, completed count,
stage, and progress bar without restarting the operation.

After the first usable page confirms the FairPrice session, each page
joins a readiness-driven queue as soon as its native **Add to cart** button is
available or its existing quantity stepper appears; a slow product no longer
blocks faster ones. Products already at the recipe's requested pack count are
accepted immediately, while lower quantities receive only the missing native
increments. Cart clicks run one at
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
