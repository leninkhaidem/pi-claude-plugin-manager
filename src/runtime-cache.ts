import { clearAutocompleteCache } from "./autocomplete.js";
import { clearDiscoveryCache } from "./discovery.js";

export function clearRuntimeCaches(): void {
	clearDiscoveryCache();
	clearAutocompleteCache();
}
