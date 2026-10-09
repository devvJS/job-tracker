import type { JSX } from "react";

/** The message to show for anything thrown or rejected. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "string" && error !== "") return error;
  return "Something went wrong";
}

/** Shows an error (usually an ApiError) as a banner, or nothing when there is no error. */
export function ErrorBanner(props: { error: unknown }): JSX.Element | null {
  if (props.error === null || props.error === undefined) return null;
  return (
    <div
      data-testid="error-banner"
      role="alert"
      className="rounded border border-red-500/60 bg-red-500/10 px-4 py-3 text-sm text-red-200"
    >
      {errorMessage(props.error)}
    </div>
  );
}
