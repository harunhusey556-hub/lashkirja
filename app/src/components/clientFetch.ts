export class ApiError extends Error {
  status: number;
  details?: any;

  constructor(message: string, status: number, details?: any) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

type ErrorPayload = { error?: { message?: string; details?: any } | string } | null;

export async function readJson<T>(
  response: Response,
  fallbackMessage: string
): Promise<T> {
  const payload = (await response.json().catch(() => null)) as ErrorPayload | T;

  if (!response.ok) {
    let message = fallbackMessage;
    let details: any = undefined;
    
    if (payload && typeof payload === "object" && "error" in payload) {
      if (typeof payload.error === "string") {
        message = payload.error;
      } else if (payload.error && typeof payload.error === "object") {
        message = payload.error.message || fallbackMessage;
        details = payload.error.details;
      }
    }
    
    throw new ApiError(message, response.status, details);
  }

  if (payload === null) {
    throw new ApiError(fallbackMessage, response.status);
  }

  return payload as T;
}

/**
 * Resilient fetch wrapper with extreme exponential backoff for network drops & transient 5xx faults.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const MAX_RETRIES = 3;
  let attempt = 0;
  
  while (attempt < MAX_RETRIES) {
    try {
      const response = await fetch(input, init);
      // If it's a 502/503/504 gateway/timeout error, we should retry!
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        throw new Error(`Transient Server Error: ${response.status}`);
      }
      return response; // 2xx, 4xx, and 500 (logic errors) are returned normally
    } catch (error) {
      attempt++;
      if (attempt >= MAX_RETRIES) {
        throw error; // Bubble up if maximum retries reached
      }
      // Wait exponentially: 500ms, 1000ms, 2000ms...
      await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
    }
  }
  
  throw new Error("apiFetch failed unexpectedly");
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.details) {
    // If we have detailed Zod/Validation issues, format them cleanly
    if (Array.isArray(error.details)) {
      return `${error.message}: ${error.details.map((d: any) => d.message || d).join(', ')}`;
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export function redirectToLogin(): void {
  window.location.replace("/login");
}
