/**
 * Every regular expression the attack-surface extractors use. They live in one place so
 * `pnpm rules:check` can prove each of them free of catastrophic backtracking with recheck,
 * exactly like the detector rules. All quantifiers are bounded and the "look back" patterns
 * only ever run on short slices (at most a few hundred characters) of a file.
 */

// ---------------------------------------------------------------- endpoints

/** Absolute URL with a scheme we care about. */
export const ABSOLUTE_URL = /^(?:https?|wss?):\/\/[a-z0-9.-]{1,253}(?::[0-9]{1,5})?(?:[/?#]|$)/i;

/** Static assets and module paths: never an endpoint. */
export const ASSET_PATH =
  /\.(?:m?js|cjs|jsx|tsx?|vue|svelte|css|scss|sass|less|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp[34]|webm|ogg|wav|flac|pdf|zip|gz|wasm)(?:[?#]|$)/i;

export const CATEGORY_ADMIN =
  /(?:^|\/)(?:admin|administrator|internal|private|debug|backoffice|back-office|staff|management|actuator|console|superuser|sudo|ops|_internal)(?:[/?#.]|$)/;
export const CATEGORY_GRAPHQL = /(?:^|\/)(?:graphql|gql|graphiql)(?:[/?#]|$)/;
export const CATEGORY_NEXT_DATA = /^\/_next\/data\//;
export const CATEGORY_AUTH =
  /(?:^|\/)(?:auth|oauth2?|login|logout|signin|sign-in|signup|sign-up|register|tokens?|sessions?|sso|saml|oidc|password|reset-password|forgot-password|mfa|2fa|otp|jwt|refresh|whoami|me)(?:[/?#.]|$)/;
export const CATEGORY_API =
  /(?:^|\/)(?:api|apis|rest|rpc|v[0-9]{1,2}|services?|ajax|wp-json|webhooks?|backend|bff|gateway|xhr|trpc|odata|json)(?:[/?#.]|$)/;
/** API hosts: `api.example.com`, `example-api.com`, `api-eu.example.com`. */
export const API_HOST = /^(?:api|apis|gateway|graphql|backend|rest)[.-]|[.-]api[.-]/;

/** Hosts whose URLs are documentation or XML namespaces, not attack surface. */
export const NOISE_HOST =
  /(?:^|\.)(?:w3\.org|schema\.org|reactjs\.org|react\.dev|fb\.me|mozilla\.org|whatwg\.org|ecma-international\.org|json-schema\.org|purl\.org|xmlsoap\.org|openxmlformats\.org|example\.(?:com|org|net)|github\.com|npmjs\.com|npmjs\.org|unpkg\.com|jsdelivr\.net|fonts\.gstatic\.com|fonts\.googleapis\.com|tailwindcss\.com|vuejs\.org|angular\.io|svelte\.dev|nextjs\.org|babeljs\.io|webpack\.js\.org)$/i;
/** Characters that never appear in a URL literal. */
export const NOT_URL_CHAR = /[\s<>"'`\\^|]/;
/** A `{name}` placeholder left by a template expression. */
export const PLACEHOLDER = /\{[^{}]{0,40}\}/g;
/** Relative API paths without a leading slash: `api/v1/users`, `v2/orders`. */
export const RELATIVE_API_START = /^(?:api|apis|graphql|rest|v[0-9]{1,2})\//i;

/** HTTP method from the call right before a URL: `axios.post(`, `this.http.get<T>(`. */
export const METHOD_CALL_BEFORE =
  /\.(get|post|put|patch|delete|head|options)\s{0,4}(?:<[^<>()]{0,80}>)?\s{0,4}\(\s{0,4}$/i;
/** `fetch(` right before a URL. */
export const FETCH_BEFORE = /(?:^|[^\w$.])fetch\s{0,4}\(\s{0,4}$/;
/** `{ method: 'POST', url: ` right before a URL. */
export const METHOD_KEY_BEFORE =
  /\bmethod\s{0,4}:\s{0,4}(?:"|'|`)(get|post|put|patch|delete|head|options)(?:"|'|`)\s{0,4},\s{0,4}url\s{0,4}:\s{0,4}$/i;
/** `{ method: 'DELETE' }` shortly after a URL (the slice ends at the next URL or `;`). */
export const METHOD_KEY_AFTER =
  /\bmethod\s{0,4}:\s{0,4}(?:"|'|`)(get|post|put|patch|delete|head|options)(?:"|'|`)/i;

/** MIME types: not endpoints. */
export const MIME_TYPE =
  /^(?:application|text|image|audio|video|font|multipart|message|model)\/[a-z0-9.+-]{1,64}$/i;
/** `xhr.open('POST', '/api/...')` right before a URL. */
export const XHR_OPEN_BEFORE =
  /\.open\s{0,4}\(\s{0,4}(?:"|'|`)(get|post|put|patch|delete|head|options)(?:"|'|`)\s{0,4},\s{0,4}$/i;
/** Config / API client URL assignments: `baseURL: '/api'`, `apiUrl = '...'`. */
export const ENDPOINT_CONTEXT_BEFORE =
  /\b(?:baseURL|baseUrl|apiUrl|apiBase|endpoint|graphqlUrl|backendUrl|serverUrl|serviceUrl|fetchUrl)\s{0,4}[:=]\s{0,4}$/i;

// ---------------------------------------------------------------- routes

/** `path: '/x'`, `path="/x"`, `path={'/x'}` right before a string. */
export const ROUTE_DEFINITION_BEFORE = /\bpath\s{0,4}[:=]\s{0,4}\{?\s{0,4}$/;
/** JSX `<Route ... path="/x"` before a string. */
export const ROUTE_JSX_BEFORE = /<Route\b[^>]{0,120}$/;
/** Keys that accompany a router path definition, looked for shortly after it. */
export const ROUTE_COMPANION =
  /\b(?:component|components|element|loadChildren|loadComponent|children|redirectTo|lazy|Component|errorElement|loader|meta|beforeEnter)\s{0,4}[:=]/;
/** Navigation targets: `router.push('/x')`, `navigate('/x')`, `<Link href="/x">`, `to="/x"`. */
export const ROUTE_NAVIGATION_BEFORE =
  /(?:\b(?:push|replace|navigate|navigateTo|navigateByUrl|redirect|permanentRedirect|prefetch)\s{0,4}\(\s{0,4}(?:\{\s{0,4}pathname\s{0,4}:\s{0,4})?|\b(?:to|href|as|pathname|redirectTo|routerLink)\s{0,4}[:=]\s{0,4}\{?\s{0,4})$/;
/** A string followed by `:`, i.e. an object key (Next.js build manifest entries). */
export const OBJECT_KEY_AFTER = /^\s{0,4}:/;
/** Path-shaped value: what a route or endpoint may contain. */
export const PATH_SHAPE = /^[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%{}]{1,300}$/;
/** Source files that can define a file-system route. */
export const ROUTE_FILE_EXT = /\.(?:jsx?|tsx?|mdx?|vue|svelte|astro)$/;
/** Non-route companions of route files: tests, stories, styles, type declarations. */
export const NON_ROUTE_FILE = /\.(?:test|spec|stories|story|module|styles?|d)$/;

// ---------------------------------------------------------------- comments

export const COMMENT_MARKER =
  /\b(TODO|FIXME|HACK|XXX|INTERNAL|BYPASS|SECURITY)\b(?:\([^)\n]{0,40}\))?(?:[ \t]{0,4}[:\-][ \t]{0,4}|[ \t]{1,4})([^\n]{0,200})/g;
export const LICENSE_COMMENT = /@license|@preserve|copyright|\(c\)\s{0,4}[0-9]{4}/i;
export const SENSITIVE_COMMENT =
  /\b(?:password|passwd|secret|token|api[ _-]?key|credential|auth|admin|bypass|disabled?|hard-?coded|temporar(?:y|ily)|remove before|debug|backdoor|insecure|vuln|csrf|xss|cors|sanitiz|unsafe|skip(?:ping)? (?:auth|check|validation))/i;

// ---------------------------------------------------------------- sinks

export const SINK_DANGEROUSLY_SET_INNER_HTML = /\bdangerouslySetInnerHTML\s{0,4}[:=]/g;
export const SINK_INNER_HTML = /\.(?:innerHTML|outerHTML)\s{0,4}\+?=(?!=)/g;
export const SINK_INSERT_ADJACENT_HTML = /\.insertAdjacentHTML\s{0,4}\(/g;
export const SINK_DOCUMENT_WRITE = /\bdocument\s{0,4}\.\s{0,4}write(?:ln)?\s{0,4}\(/g;
export const SINK_EVAL = /(?<![\w$.])eval\s{0,4}\(/g;
export const SINK_NEW_FUNCTION = /\bnew\s{1,4}Function\s{0,4}\(/g;
export const SINK_STRING_TIMER = /\bset(?:Timeout|Interval)\s{0,4}\(\s{0,4}(?:"|'|`)/g;
export const SINK_SRCDOC = /\.srcdoc\s{0,4}=(?!=)/g;
export const SINK_MESSAGE_LISTENER = /\baddEventListener\s{0,4}\(\s{0,4}(?:"|'|`)/g;
export const SINK_ONMESSAGE = /\b(?:window|self|globalThis)\s{0,2}\.\s{0,2}onmessage\s{0,4}=(?!=)/g;
export const SINK_POST_MESSAGE = /\.postMessage\s{0,4}\(/g;
export const SINK_LOCATION_ASSIGN =
  /\blocation(?:\s{0,2}\.\s{0,2}href)?\s{0,4}=(?!=)|\blocation\s{0,2}\.\s{0,2}(?:assign|replace)\s{0,4}\(|\bwindow\s{0,2}\.\s{0,2}open\s{0,4}\(/g;
export const SINK_VUE_V_HTML = /\bv-html\s{0,4}=/g;
export const SINK_SVELTE_HTML = /\{@html\s/g;
export const SINK_ANGULAR_BYPASS =
  /\bbypassSecurityTrust(?:Html|Script|Style|Url|ResourceUrl)\s{0,4}\(/g;
export const SINK_ANGULAR_INNER_HTML = /\[(?:innerHTML|outerHTML)\]\s{0,4}=/g;
export const SINK_SSR_STATE = /\b(?:__NEXT_DATA__|__INITIAL_STATE__|__NUXT__|__REDUX_STATE__)\b/g;

// ---------------------------------------------------------------- __NEXT_DATA__ keys

export const NEXT_DATA_CREDENTIAL_KEY =
  /(?:^|[_.-])(?:token|secret|apikey|api[_-]?key|password|passwd|privatekey|private[_-]?key|clientsecret|client[_-]?secret|jwt|session|cookie|auth|bearer|dsn|connectionstring|databaseurl|accesskey|signingkey)(?:$|[_.-])/i;
export const NEXT_DATA_PRIVILEGE_KEY =
  /(?:^|[_.-])(?:isadmin|is[_-]?admin|role|roles|permission|permissions|scope|scopes|internal|debug|featureflags|feature[_-]?flags|admin|staff|superuser)(?:$|[_.-])/i;
export const NEXT_DATA_PII_KEY =
  /(?:^|[_.-])(?:email|phone|mobile|ssn|address|ipaddress|ip[_-]?address|creditcard|billing|stripecustomer|stripe[_-]?customer)(?:$|[_.-])/i;

/** Receiver of `addEventListener` that makes a message listener cross-origin reachable. */
export const WINDOW_RECEIVER_BEFORE =
  /(?:\b(?:window|self|globalThis|top|parent)\s{0,2}\.\s{0,2}|(?:^|[^\w$.\s])\s{0,4})$/;
/** An origin check inside a message handler. */
export const ORIGIN_CHECK = /\.origin\b|\borigin\s{0,4}(?:===?|!==?)/;
/** `postMessage(data, '*')`: wildcard target origin. */
export const WILDCARD_TARGET = /,\s{0,4}(?:"\*"|'\*'|`\*`)\s{0,4}[,)]/;
/** The value is sanitized right there. */
export const SANITIZED = /sanitiz|DOMPurify|purify|escapeHtml|xss\(/i;
/** User-controlled-looking input on the same line as a redirect. */
export const REDIRECT_TAINT =
  /search|hash|query|param|redirect|return|next|callback|continue|target|dest|goto|url/i;
/** `const location = ...`: a declaration, not a navigation. */
export const DECLARATION_BEFORE = /\b(?:const|let|var)\s{1,4}$/;
/** Member access right before a name: `state.location`. */
export const DOTTED_BEFORE = /\.\s{0,2}$/;
/** Receivers whose `location` is the browser's. */
export const LOCATION_RECEIVER_BEFORE =
  /\b(?:window|document|top|self|parent|globalThis)\s{0,2}\.\s{0,2}$/;

/** For `pnpm rules:check` and the unit tests. */
export const INTEL_PATTERNS: readonly { name: string; regex: RegExp }[] = Object.entries({
  ABSOLUTE_URL,
  ASSET_PATH,
  CATEGORY_ADMIN,
  CATEGORY_GRAPHQL,
  CATEGORY_NEXT_DATA,
  CATEGORY_AUTH,
  CATEGORY_API,
  API_HOST,
  NOISE_HOST,
  NOT_URL_CHAR,
  PLACEHOLDER,
  RELATIVE_API_START,
  METHOD_CALL_BEFORE,
  FETCH_BEFORE,
  METHOD_KEY_BEFORE,
  METHOD_KEY_AFTER,
  MIME_TYPE,
  XHR_OPEN_BEFORE,
  ENDPOINT_CONTEXT_BEFORE,
  ROUTE_DEFINITION_BEFORE,
  ROUTE_JSX_BEFORE,
  ROUTE_COMPANION,
  ROUTE_NAVIGATION_BEFORE,
  OBJECT_KEY_AFTER,
  PATH_SHAPE,
  ROUTE_FILE_EXT,
  NON_ROUTE_FILE,
  COMMENT_MARKER,
  LICENSE_COMMENT,
  SENSITIVE_COMMENT,
  SINK_DANGEROUSLY_SET_INNER_HTML,
  SINK_INNER_HTML,
  SINK_INSERT_ADJACENT_HTML,
  SINK_DOCUMENT_WRITE,
  SINK_EVAL,
  SINK_NEW_FUNCTION,
  SINK_STRING_TIMER,
  SINK_SRCDOC,
  SINK_MESSAGE_LISTENER,
  SINK_ONMESSAGE,
  SINK_POST_MESSAGE,
  SINK_LOCATION_ASSIGN,
  SINK_VUE_V_HTML,
  SINK_SVELTE_HTML,
  SINK_ANGULAR_BYPASS,
  SINK_ANGULAR_INNER_HTML,
  SINK_SSR_STATE,
  NEXT_DATA_CREDENTIAL_KEY,
  NEXT_DATA_PRIVILEGE_KEY,
  NEXT_DATA_PII_KEY,
  WINDOW_RECEIVER_BEFORE,
  ORIGIN_CHECK,
  WILDCARD_TARGET,
  SANITIZED,
  REDIRECT_TAINT,
  DECLARATION_BEFORE,
  DOTTED_BEFORE,
  LOCATION_RECEIVER_BEFORE,
}).map(([name, regex]) => ({ name, regex }));
