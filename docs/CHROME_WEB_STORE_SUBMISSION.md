
Chrome Web Store Submission Notes
Single purpose

CookieGate provides local browser cookie visibility and user-controlled cleanup planning.

Permission justifications
cookies

CookieGate uses the cookies permission to list cookie metadata for the active site and browser-held domains, classify cookies, show hash previews instead of raw values, and manually remove cookies only when the user requests cleanup.

browsingData

CookieGate uses browsingData only for optional browser cleanup actions selected by the user, such as clearing cache, local storage, IndexedDB, or service workers. Cleanup is user-controlled and not automatic.

storage

CookieGate uses storage to save local extension settings such as global mode, site mode, domain cleanup rules, and local evidence/session state. This data stays local to the browser extension.

tabs

CookieGate uses tabs to identify the currently active tab’s URL/domain so the popup can show the correct site context and apply site-specific inspection or cleanup planning.

activeTab

CookieGate uses activeTab to access the current tab only when the user opens or interacts with CookieGate, so the extension can inspect the active site context without persistent page access.

Host permissions

CookieGate uses host permissions to inspect and manage cookies for the domains the user chooses to review or clean. Host access supports local cookie visibility and user-controlled cleanup; CookieGate does not export raw cookie values.

Remote code

CookieGate does not use remote code. All JavaScript, CSS, HTML, and extension logic are packaged inside the extension. No external scripts, remote modules, eval-loaded code, or remote WebAssembly are used.
