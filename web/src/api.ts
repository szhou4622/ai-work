/** 统一 REST 客户端（带会话 Cookie；禁用缓存，保证保存后立即看到最新数据） */
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const hasBody = options.body != null;
  const res = await fetch(path, {
    ...options,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      // 只有带 body 的请求才声明 JSON（否则 DELETE 等无 body 请求会被 Fastify 拒绝 400）
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    window.location.href = '/login';
    throw new Error('unauthorized');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    (err as any).status = res.status;
    (err as any).data = data;
    throw err;
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const put = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'PUT', body: JSON.stringify(body ?? {}) });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });
