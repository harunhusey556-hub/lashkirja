import { ZodError } from "zod";
import { noStoreJson } from "./http-security";

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: any;
  };
}

export class AppError extends Error {
  public code: string;
  public statusCode: number;
  public details?: any;

  constructor(message: string, code: string = "INTERNAL_ERROR", statusCode: number = 500, details?: any) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super(message, "VALIDATION_FAILED", 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = "Unauthorized") {
    super(message, "UNAUTHORIZED", 401);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = "Resource not found") {
    super(message, "NOT_FOUND", 404);
  }
}

/**
 * Wraps an API route handler to uniformly capture and format errors.
 */
export function withErrorHandler(
  handler: (req: any, ...args: any[]) => Promise<Response>
) {
  return async (req: any, ...args: any[]): Promise<Response> => {
    try {
      return await handler(req, ...args);
    } catch (error: any) {
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

      if (error && typeof error === "object" && error.name === "PrismaClientKnownRequestError") {
        const code = (error as any).code;
        // P2002: Unique constraint failed
        // P2003: Foreign key constraint failed
        // P2025: Record not found
        if (code === "P2002" || code === "P2003") {
          return noStoreJson(
            { error: { code: "DATABASE_CONSTRAINT", message: "A database constraint was violated." } },
            { status: 409 }
          );
        }
        if (code === "P2025") {
          return noStoreJson(
            { error: { code: "NOT_FOUND", message: "Resource not found in database." } },
            { status: 404 }
          );
        }
      }

      if (error && typeof error === "object" && error.name === "PrismaClientValidationError") {
        console.error("[PrismaClientValidationError]", error.message);
        return noStoreJson(
          { error: { code: "DATABASE_VALIDATION", message: "Database structural validation failed." } },
          { status: 400 }
        );
      }

      // Log untyped/unexpected errors for debugging server-side only
      console.error("[API Error Handler]", req.method, req.url, error);

      return noStoreJson(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred. Please try again later.",
          },
        },
        { status: 500 }
      );
    }
  };
}
