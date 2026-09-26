import { ZodError } from "zod";
import type { NextRequest } from "next/server";
import { noStoreJson } from "./http-security";

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  public code: string;
  public statusCode: number;
  public details?: unknown;

  constructor(
    message: string,
    code: string = "INTERNAL_ERROR",
    statusCode: number = 500,
    details?: unknown
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "VALIDATION_FAILED", 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = "Kirjautuminen vaaditaan") {
    super(message, "UNAUTHORIZED", 401);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = "Resurssia ei löytynyt") {
    super(message, "NOT_FOUND", 404);
  }
}

/**
 * Wraps an API route handler to uniformly capture and format errors.
 */
/** Prisma surfaces its errors by name and code rather than by exported class. */
interface PrismaLikeError {
  name?: string;
  code?: string;
  message?: string;
}

function asPrismaError(error: unknown): PrismaLikeError | null {
  return error && typeof error === "object" ? (error as PrismaLikeError) : null;
}

export function withErrorHandler<Args extends unknown[]>(
  handler: (req: NextRequest, ...args: Args) => Promise<Response>
) {
  return async (req: NextRequest, ...args: Args): Promise<Response> => {
    try {
      return await handler(req, ...args);
    } catch (error: unknown) {
      if (error instanceof AppError) {
        return noStoreJson(
          { error: { code: error.code, message: error.message, details: error.details } },
          { status: error.statusCode }
        );
      }

      if (error instanceof ZodError) {
        return noStoreJson(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "Invalid request payload",
              details: error.issues,
            },
          },
          { status: 400 }
        );
      }

      const prismaError = asPrismaError(error);
      if (prismaError?.name === "PrismaClientKnownRequestError") {
        const code = prismaError.code;
        // P2002: Unique constraint failed
        // P2003: Foreign key constraint failed
        // P2025: Record not found
        if (code === "P2002" || code === "P2003") {
          return noStoreJson(
            { error: { code: "DATABASE_CONSTRAINT", message: "Tietokantarajoitus rikkoutui." } },
            { status: 409 }
          );
        }
        if (code === "P2025") {
          return noStoreJson(
            { error: { code: "NOT_FOUND", message: "Resurssia ei löytynyt tietokannasta." } },
            { status: 404 }
          );
        }
      }

      if (prismaError?.name === "PrismaClientValidationError") {
        console.error("[PrismaClientValidationError]", prismaError.message);
        return noStoreJson(
          { error: { code: "DATABASE_VALIDATION", message: "Tietokannan rakenteen validointi epäonnistui." } },
          { status: 400 }
        );
      }

      // Log untyped/unexpected errors for debugging server-side only
      console.error("[API Error Handler]", req.method, req.url, error);

      return noStoreJson(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "Odottamaton virhe. Yritä myöhemmin uudelleen.",
          },
        },
        { status: 500 }
      );
    }
  };
}

/** Message of an unknown throw, for logging and for user-facing fallbacks. */
export function errorText(error: unknown, fallback = "Tuntematon virhe"): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}
