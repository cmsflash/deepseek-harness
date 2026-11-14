/**
 * Local thread copy plugin, node half.
 *
 * The copy lives entirely in the browser: this entry exists so the Loader
 * can register the plugin everywhere the Web bundle boots.
 */

/** Host/GUI-process apply — no node half is needed. */
export function apply(): void {}
