/**
 * Passive MAIN-world runtime observer injected ONLY on enabled sites via `chrome.scripting`.
 * Never modifies network traffic or sends data externally; bridges compact summaries to the
 * ISOLATED-world collector via `window.postMessage` on `window.location.origin`.
 */
export default defineUnlistedScript(() => {
  const FLAG = '__maphoundRuntimeHookInstalled';
  const win = window as unknown as Record<string, unknown>;
  if (win[FLAG]) return;
  win[FLAG] = true;

  let domGuardEnabled = false;
  let domHooksInstalled = false;

  const emit = (kind: 'api' | 'dom', payload: Record<string, unknown>) => {
    try {
      window.postMessage({ __mhRuntime: true, kind, payload }, window.location.origin);
    } catch {
      // Ignore cross-origin or detached window errors.
    }
  };

  // Listen for opt-in Runtime Guard control toggle from ISOLATED collector
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data as { __mhControl?: string; enabled?: boolean } | null;
    if (data?.__mhControl === 'dom-guard') {
      domGuardEnabled = Boolean(data.enabled);
      if (domGuardEnabled && !domHooksInstalled) installDomGuard();
      return;
    }
    if (domGuardEnabled && !(data as { __mhRuntime?: boolean } | null)?.__mhRuntime) {
      const shape =
        event.data && typeof event.data === 'object'
          ? `object{${Object.keys(event.data as Record<string, unknown>)
              .slice(0, 8)
              .join(', ')}}`
          : typeof event.data;
      emit('dom', {
        kind: 'postMessage',
        detail: `from ${event.origin || 'null'} (${shape})`,
        senderOrigin: event.origin || 'null',
        hasListener: true,
        rawStack: '',
      });
    }
  });

  // 1. Passive fetch wrapper
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : '';
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const headerNames: string[] = [];
    const rawHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((_v, k) => headerNames.push(k));
    } else if (Array.isArray(rawHeaders)) {
      for (const pair of rawHeaders) if (pair[0]) headerNames.push(pair[0]);
    } else if (rawHeaders && typeof rawHeaders === 'object') {
      for (const k of Object.keys(rawHeaders)) headerNames.push(k);
    }
    const requestBody = typeof init?.body === 'string' ? init.body.slice(0, 32_000) : null;

    const response = await origFetch(input, init);
    try {
      const ct = response.headers.get('content-type') ?? '';
      let responseBody: string | null = null;
      if (ct.includes('json')) {
        responseBody = (await response.clone().text()).slice(0, 32_000);
      }
      emit('api', { url, method, status: response.status, headerNames, requestBody, responseBody });
    } catch {
      // Never interfere with page fetch.
    }
    return response;
  };

  // 2. Passive XMLHttpRequest wrapper
  const xhrMeta = new WeakMap<
    XMLHttpRequest,
    { method: string; url: string; headerNames: string[]; requestBody: string | null }
  >();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    xhrMeta.set(this, {
      method: method.toUpperCase(),
      url: String(url),
      headerNames: [],
      requestBody: null,
    });
    return origOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
    xhrMeta.get(this)?.headerNames.push(name);
    return origSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = xhrMeta.get(this);
    if (meta && typeof body === 'string') {
      meta.requestBody = body.slice(0, 32_000);
    }
    this.addEventListener('loadend', () => {
      if (!meta) return;
      try {
        const ct = this.getResponseHeader('content-type') ?? '';
        const responseBody =
          ct.includes('json') && typeof this.responseText === 'string'
            ? this.responseText.slice(0, 32_000)
            : null;
        emit('api', {
          url: meta.url,
          method: meta.method,
          status: this.status,
          headerNames: meta.headerNames,
          requestBody: meta.requestBody,
          responseBody,
        });
      } catch {
        // Ignore non-text XHR responses.
      }
    });
    return origSend.call(this, body ?? null);
  };

  // 3. Opt-in DOM Guard hooks (installed only when user enables Runtime Guard)
  function installDomGuard() {
    domHooksInstalled = true;
    try {
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      if (desc?.set && desc.configurable) {
        Object.defineProperty(Element.prototype, 'innerHTML', {
          ...desc,
          set(val: string) {
            if (domGuardEnabled && typeof val === 'string' && val.length > 0) {
              emit('dom', {
                kind: 'innerHTML',
                detail: `${this.tagName.toLowerCase()}.innerHTML = (${val.length} chars)`,
                rawStack: new Error().stack ?? '',
              });
            }
            return desc.set!.call(this, val);
          },
        });
      }
    } catch {
      // Ignore locked prototypes.
    }

    try {
      const origEval = window.eval;
      window.eval = function (code: string) {
        if (domGuardEnabled && typeof code === 'string') {
          emit('dom', {
            kind: 'eval',
            detail: `eval(${code.slice(0, 80)})`,
            rawStack: new Error().stack ?? '',
          });
        }
        return origEval.call(window, code);
      };
    } catch {
      // Ignore locked eval.
    }
  }
});
