// What each browser says when a lazily loaded page's file can't be fetched: Chrome "Failed to fetch
// dynamically imported module", Firefox "error loading dynamically imported module", Safari
// "Importing a module script failed"; and Vite's "Unable to preload CSS for ..." when a page's
// stylesheet is gone. Webpack-style bundlers name theirs ChunkLoadError ("Loading chunk 3 failed").
const dynamicImportMessage =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload css|loading (css )?chunk .* failed/i;

/**
 * True for an error that says a page's code could not be fetched, which after a redeploy means
 * this tab is older than the console it talks to; a reload fetches the current version.
 */
export const isDynamicImportError = (error: unknown): boolean =>
  error instanceof Error && (/chunkloaderror/i.test(error.name) || dynamicImportMessage.test(error.message));
