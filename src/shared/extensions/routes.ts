/** One source of truth for the dashboard's own HTTP routes: the backend registers
 *  them and the browser fetch/import layer uses the same strings. */
export const EXTENSIONS_PATH = '/api/session-dashboard/extensions'
export const EXTENSION_MODULE_PATH = `${EXTENSIONS_PATH}/module`
export const EXTENSION_ENABLED_PATH = `${EXTENSIONS_PATH}/enabled`
