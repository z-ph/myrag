export class ApiError extends Error {
  readonly status: number;
  readonly details?: Record<string, string>;

  constructor(status: number, message: string, details?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

const TOKEN_KEY = 'myrag-token';
const GUEST_TOKEN_KEY = 'myrag-guest-token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** 访客 token（未登录问答落库用，静默签发） */
export function getGuestToken(): string | null {
  return localStorage.getItem(GUEST_TOKEN_KEY);
}

export function setGuestToken(token: string | null): void {
  if (token) localStorage.setItem(GUEST_TOKEN_KEY, token);
  else localStorage.removeItem(GUEST_TOKEN_KEY);
}
