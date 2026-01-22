import { createApiClient } from "./apiClientAxios";

// Create a client
export const api = createApiClient({
  baseURL: "https://example.com",
  timeoutMs: 10_000,
  dedupe: {
    enabled: true,
    mode: "share", // or "cancel-previous"
    methods: ["get", "head"], // safest default
  },
});

// 1) REQUEST DEDUPE (share in-flight GET)
export async function demoDedupe() {
  // Both calls happen at once; second will share the first response (no duplicate network call).
  const [a, b] = await Promise.all([
    api.get<{ items: string[] }>("/feed", { params: { q: "react" } }),
    api.get<{ items: string[] }>("/feed", { params: { q: "react" } }),
  ]);

  return { a, b };
}

// 2) TOKEN REFRESH QUEUE
// If /private returns 401, the client will:
// - start a single refresh request to /auth/refresh
// - queue all other 401-failed requests until refresh completes
// - retry them with the new access token
export async function demoRefreshQueue() {
  const data = await api.get<{ ok: boolean }>("/private");
  return data;
}

// 3) PROGRESS EVENTS (upload + download)
export async function demoUploadWithProgress(fileUri: string) {
  const form = new FormData();
  // RN FormData file shape:
  form.append("file", {
    // @ts-expect-error RN file type
    uri: fileUri,
    name: "upload.jpg",
    type: "image/jpeg",
  });

  const res = await api.post<{ id: string }>("/upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
    onUploadProgress: (evt) => {
      const total = evt.total ?? 0;
      const loaded = evt.loaded ?? 0;
      if (total > 0) {
        const pct = Math.round((loaded / total) * 100);
        console.log("upload %", pct);
      } else {
        console.log("upload bytes", loaded);
      }
    },
    onDownloadProgress: (evt) => {
      const total = evt.total ?? 0;
      const loaded = evt.loaded ?? 0;
      if (total > 0) {
        const pct = Math.round((loaded / total) * 100);
        console.log("download %", pct);
      } else {
        console.log("download bytes", loaded);
      }
    },
  });

  return res;
}
