import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError } from "../../lib/api.ts";
import { ApplicationForm } from "./ApplicationForm.tsx";
import { EMPTY_FORM, type FormValues, createApplication, createBody, recordOf } from "./applications-api.ts";

/** /applications/new: the create form. On success, opens the new record. */
export function NewApplicationPage() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (values: FormValues) => {
    setBusy(true);
    setError(null);
    try {
      const record = await createApplication(createBody(values));
      navigate(`/applications/${encodeURIComponent(record.id)}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const existing = error instanceof ApiError && error.status === 409 ? recordOf(error) : null;

  return (
    <section className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-xl font-bold">New application</h1>
      <ApplicationForm
        title="Add an application"
        initial={EMPTY_FORM}
        submitLabel="Create"
        busy={busy}
        error={error}
        errorExtra={
          existing && (
            <p className="mt-2">
              Existing record:{" "}
              <Link to={`/applications/${encodeURIComponent(existing.id)}`}>
                {existing.company}, {existing.role_title}
              </Link>
            </p>
          )
        }
        onSubmit={submit}
      />
    </section>
  );
}
