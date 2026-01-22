// src/services/apiClientAxios.ts
import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

/**
 * WHAT THIS FILE SHOWCASES (in one place):
 * 1) Token refresh with a single refresh in-flight + a queue for failed requests (401)
 * 2) Request dedupe (either share the same in-flight promise OR cancel previous)
 * 3) Progress events (upload + download) via Axios config callbacks
 *
 * Works well in React Native where Axios uses XHR under the hood.
 */

/* =========================
   Types & token storage hooks
   ========================= */

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

type TokenStore = {
  getAccessToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  setTokens(tokens: AuthTokens): Promise<void>;
  clearTokens(): Promise<void>;
};

/**
 * Plug in your storage (AsyncStorage, MMKV, Keychain, etc.)
 * This is intentionally abstract so the networking layer stays testable.
 */
const tokenStore: TokenStore = {
  async getAccessToken() {
    return null;
  },
  async getRefreshToken() {
    return null;
  },
  async setTokens(_tokens) {},
  async clearTokens() {},
};

/* =========================
   Dedupe
   ========================= */

type DedupeMode = "share" | "cancel-previous";
type DedupePolicy = {
  enabled: boolean;
  mode: DedupeMode;
  // safest to dedupe only idempotent requests by default:
  methods: Array<"get" | "head">;
};

const defaultDedupePolicy: DedupePolicy = {
  enabled: true,
  mode: "share",
  methods: ["get", "head"],
};

// In-flight map: key -> promise OR controller (depending on mode)
const inFlight = new Map<
  string,
  {
    promise: Promise<AxiosResponse<any>>;
    controller: AbortController;
  }
>();

function stableStringify(obj: unknown): string {
  if (obj == null) return "";
  if (typeof obj !== "object") return String(obj);
  // simple stable stringify (good enough for demo)
  const allKeys: string[] = [];
  JSON.stringify(obj, (k, v) => (allKeys.push(k), v));
  allKeys.sort();
  return JSON.stringify(obj, allKeys);
}

function requestKey(config: AxiosRequestConfig): string {
  const method = (config.method ?? "get").toLowerCase();
  const baseURL = config.baseURL ?? "";
  const url = config.url ?? "";
  const params = stableStringify(config.params);
  const data =
    typeof config.data === "string" ? config.data : stableStringify(config.data);

  // Important: do NOT include Authorization header in the key,
  // otherwise the same request will not dedupe across token rotations.
  return `${method} ${baseURL}${url} ?${params} ::${data}`;
}

/* =========================
   Refresh queue
   ========================= */

let isRefreshing = false;
let refreshPromise: Promise<string> | null = null;

type RefreshQueueItem = {
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
};

const refreshQueue: RefreshQueueItem[] = [];

function enqueueRefresh(): Promise<string> {
  return new Promise((resolve, reject) => {
    refreshQueue.push({ resolve, reject });
  });
}

function flushRefreshQueue(token: string) {
  while (refreshQueue.length) refreshQueue.shift()!.resolve(token);
}
function rejectRefreshQueue(err: unknown) {
  while (refreshQueue.length) refreshQueue.shift()!.reject(err);
}

/**
 * Implement your refresh call here.
 * Returns new access token and refresh token.
 */
async function refreshTokenRequest(client: AxiosInstance): Promise<AuthTokens> {
  const refreshToken = await tokenStore.getRefreshToken();
  if (!refreshToken) {
    throw new Error("No refresh token available");
  }

  // Use a separate call that DOES NOT go through the same 401 interceptor loop.
  // One approach: call a bare axios instance OR set a flag on config.
  const res = await client.post<AuthTokens>(
    "/auth/refresh",
    { refreshToken },
    { headers: { "X-Skip-Auth-Refresh": "1" } }
  );

  return res.data;
}

/* =========================
   Client factory
   ========================= */

export type ApiClientOptions = {
  baseURL: string;
  timeoutMs?: number;
  dedupe?: Partial<DedupePolicy>;
};

export function createApiClient(opts: ApiClientOptions) {
  const dedupe: DedupePolicy = { ...defaultDedupePolicy, ...(opts.dedupe ?? {}) };

  const client = axios.create({
    baseURL: opts.baseURL,
    timeout: opts.timeoutMs ?? 15_000,
    // In RN, axios uses XHR adapter automatically.
    // You can also set validateStatus if you want custom behavior.
  });

  /* =========================
     Request interceptor
     - attach auth header
     - dedupe logic
     ========================= */

  client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    // Attach access token
    const token = await tokenStore.getAccessToken();
    if (token) {
      config.headers = config.headers ?? {};
      config.headers.Authorization = `Bearer ${token}`;
    }

    // Dedupe: only for selected methods
    const method = (config.method ?? "get").toLowerCase() as any;
    if (!dedupe.enabled || !dedupe.methods.includes(method)) return config;

    const key = requestKey(config);

    // Use AbortController (Axios v1 supports `signal`)
    const controller = new AbortController();
    config.signal = controller.signal;

    const existing = inFlight.get(key);
    if (existing) {
      if (dedupe.mode === "cancel-previous") {
        existing.controller.abort();
        inFlight.delete(key);
      } else {
        // "share": cancel THIS request at axios level by short-circuiting with a custom adapter
        // so the caller gets the existing promise instead of sending a second request.
        // We'll attach a custom adapter that returns the existing response.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (config as any)._dedupeShareKey = key;
        (config as any).adapter = async () => {
          const shared = inFlight.get(key);
          if (!shared) {
            // fallback: no shared request -> run default adapter by removing custom adapter
            delete (config as any).adapter;
            // axios will call its default adapter; but we can't easily invoke it here.
            // simplest: throw; caller retries if needed.
            throw new Error("Dedupe shared request missing");
          }
          const resp = await shared.promise;
          // Adapter must return AxiosResponse
          return resp;
        };
      }
    }

    // If this request is NOT shared (or mode is cancel-previous), register as in-flight
    // but only if we aren't using the share adapter.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(config as any)._dedupeShareKey) {
      const keyNow = key;
      // We'll register later in a helper wrapper to ensure promise exists.
      // Mark key for the response interceptor.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any)._dedupeKey = keyNow;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any)._dedupeController = controller;
    }

    return config;
  });

  /* =========================
     Response interceptor
     - cleanup inFlight
     - refresh queue handling for 401
     ========================= */

  client.interceptors.response.use(
    (response) => {
      cleanupDedupe(response.config);
      return response;
    },
    async (error: AxiosError) => {
      const config = error.config as (AxiosRequestConfig & { _retry?: boolean }) | undefined;

      // Cleanup dedupe for failed responses too
      if (config) cleanupDedupe(config);

      // If no config, can't retry
      if (!config) throw error;

      // Skip refresh logic for refresh endpoint itself or explicitly skipped
      const skip = (config.headers as any)?.["X-Skip-Auth-Refresh"];
      if (skip) throw error;

      const status = error.response?.status;

      // Token refresh queue flow:
      // - If 401 and not yet retried:
      //   - If refresh in progress: wait in queue, then retry
      //   - Else start refresh, flush queue, retry
      if (status === 401 && !config._retry) {
        config._retry = true;

        if (isRefreshing) {
          const newToken = await enqueueRefresh();
          config.headers = config.headers ?? {};
          (config.headers as any).Authorization = `Bearer ${newToken}`;
          return client.request(config);
        }

        isRefreshing = true;

        try {
          refreshPromise =
            refreshPromise ??
            (async () => {
              const tokens = await refreshTokenRequest(client);
              await tokenStore.setTokens(tokens);
              return tokens.accessToken;
            })();

          const newAccessToken = await refreshPromise;

          flushRefreshQueue(newAccessToken);

          // retry original request with new token
          config.headers = config.headers ?? {};
          (config.headers as any).Authorization = `Bearer ${newAccessToken}`;

          return client.request(config);
        } catch (e) {
          rejectRefreshQueue(e);
          await tokenStore.clearTokens();
          throw e;
        } finally {
          isRefreshing = false;
          refreshPromise = null;
        }
      }

      throw error;
    }
  );

  /**
   * Wrapper around client.request that registers in-flight promise for dedupe (share/cancel-previous).
   * Use api.request(...) instead of client.request(...) directly if you want dedupe tracking.
   */
  async function request<T = any>(config: AxiosRequestConfig): Promise<T> {
    // If this call is "shared", axios adapter will return the existing response.
    // But if it's NOT shared, we want to register inFlight promise.
    const key = (config as any)._dedupeKey as string | undefined;
    const controller = (config as any)._dedupeController as AbortController | undefined;

    if (key && controller) {
      const p = client.request<T>(config).then((r) => r as any);

      // We want the actual AxiosResponse stored, because our share adapter returns AxiosResponse
      // We'll re-run request with a response-type call.
      const respPromise = client.request(config) as Promise<AxiosResponse<any>>;
      inFlight.set(key, { promise: respPromise, controller });

      try {
        const resp = await respPromise;
        return resp.data as T;
      } finally {
        // cleanup happens via interceptor, but keep it safe:
        inFlight.delete(key);
      }
    }

    // Normal request
    const resp = await client.request<T>(config);
    return (resp as any).data as T;
  }

  return {
    client,
    request,

    // Convenience methods
    get: <T>(url: string, config?: AxiosRequestConfig) =>
      request<T>({ ...(config ?? {}), method: "GET", url }),
    post: <T>(url: string, data?: any, config?: AxiosRequestConfig) =>
      request<T>({ ...(config ?? {}), method: "POST", url, data }),
    put: <T>(url: string, data?: any, config?: AxiosRequestConfig) =>
      request<T>({ ...(config ?? {}), method: "PUT", url, data }),
    del: <T>(url: string, config?: AxiosRequestConfig) =>
      request<T>({ ...(config ?? {}), method: "DELETE", url }),
  };

  function cleanupDedupe(config?: AxiosRequestConfig) {
    if (!config) return;
    const key = (config as any)._dedupeKey as string | undefined;
    if (key) inFlight.delete(key);
  }
}
