/** Everything the sync core needs from its host is injected through these interfaces: no direct globals. */

export type Unsub = () => void;

/** Async key/value store. Web: localStorage. React Native: SecureStore / AsyncStorage / MMKV. Keys are namespaced by the core. */
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Page/app lifecycle: connectivity returning, the app becoming visible, and being hidden (flush to storage). */
export interface Lifecycle {
  isVisible(): boolean;
  onOnline(cb: () => void): Unsub;
  onVisible(cb: () => void): Unsub;
  onHide(cb: () => void): Unsub;
}

/**
 * Optional device store for the data key between launches ("stay signed in").
 * Web: a non-extractable CryptoKey in IndexedDB. RN: the platform keychain, if it can hold a key.
 */
export interface KeyStore {
  save(userId: string, key: CryptoKey): Promise<void>;
  load(userId: string): Promise<CryptoKey | null>;
  clear(userId: string): Promise<void>;
}

export interface ResponseLike {
  status: number;
  ok: boolean;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: any; signal?: any }) => Promise<ResponseLike>;

export interface Deps {
  storage: KV;
  fetch: FetchLike;
  crypto: import('./crypto.ts').CryptoLike;
  clock: Clock;
  lifecycle: Lifecycle;
  keyStore?: KeyStore;
  /** Dispatch a named event to the UI (web: window.dispatchEvent(new CustomEvent(...))). */
  emit?(name: string, detail: unknown): void;
  /** Create an abortable handle so timed-out requests are cancelled (web: AbortController). */
  abort?(): { signal: unknown; abort(): void };
  log?(...args: unknown[]): void;
}

export interface Options {
  baseUrl: string;
  pollMs: number;
  /** PBKDF2 rounds for NEW keys. Production keeps the default (600,000). Lower values exist for tests on runtimes with a cap. */
  kdfIterations: number;
  /** Refuse to derive keys with fewer rounds than this, even if the server asks (anti-downgrade). */
  minKdfIterations: number;
  timeoutMs: number;
}

export interface SessionUser { id: string; email: string; name: string }
export interface Session { token: string; expiresAt: number; user: SessionUser; stay: boolean }

export type SyncState = 'signed-out' | 'locked' | 'offline' | 'error' | 'pending' | 'synced';
export interface SyncStatus { state: SyncState; pending: number; lastSyncAt: number | null; error: { code: string; message: string } | null }

export type SyncError = Error & { code: string; status?: number };
