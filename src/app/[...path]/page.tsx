/**
 * Catch-all route handler for path-based navigation.
 *
 * Next.js will serve this page for any URL that doesn't match a more
 * specific route (such as /api/* routes). It reuses the main app shell
 * from the root page, which reads the pathname via useNavSync to
 * determine which page to render.
 *
 * This is the key enabler for URL-based navigation like:
 *   /explore        → explore page
 *   /@alice          → profile page (username param)
 *   /moodboards/abc → moodboards page (id param)
 *   /styles/cool    → Styles hub Vault tab (id param)
 */

import HomePage from "../page";

export default function CatchAllPage() {
  return <HomePage />;
}
