// Brain Bolt — AI Quiz Preparation: start page (Stage 1).
//
// Host uploads a PDF or image. The flow:
//   1. Call prepUploadDocument → get a short-lived signed upload URL + jobId.
//   2. Client PUTs the file directly to the signed URL (keeps large files out
//      of the server-function request body).
//   3. Call prepConfirmUpload → validates actual bytes (mime/size/pages),
//      creates the extraction stage.
//   4. Redirect to /prep/$jobId to watch the pipeline.
//
// Server-only server fns; AWS credentials never reach the client.

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { HostShell } from "@/components/host-shell";
import { useAuthUser } from "@/hooks/use-auth-user";
import {
  prepUploadDocument,
  prepConfirmUpload,
  PREP_MAX_FILE_SIZE,
} from "@/lib/api/prep.functions";
import { toastError } from "@/lib/errors";

const ACCEPTED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".webp"];

export const Route = createFileRoute("/prep/new")({
  component: PrepNew,
});

function PrepNew() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ext = (name: string) => name.slice(name.lastIndexOf(".")).toLowerCase();

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setError(null);
    if (!f) return;
    const e2 = ext(f.name);
    if (!ACCEPTED_EXTENSIONS.includes(e2)) {
      setError("Unsupported file type. Upload a PDF, PNG, JPEG, or WebP.");
      setFile(null);
    }
  }

  async function onUpload() {
    if (!file) {
      setError("Choose a PDF or image to upload.");
      return;
    }
    if (!ACCEPTED_EXTENSIONS.includes(ext(file.name))) {
      setError("Unsupported file type. Upload a PDF, PNG, JPEG, or WebP.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      // 1. Request a signed upload URL + create the job + document rows.
      const started = await prepUploadDocument({
        data: { fileName: file.name, mimeType: file.type },
      });
      if (started.error || !started.uploadUrl || !started.jobId) {
        setError(
          started.error === "not_authorized"
            ? "You're not allowed to start a preparation job."
            : started.error === "over_limit"
              ? "AI preparation is temporarily unavailable."
              : "Couldn't start the upload. Try again.",
        );
        return;
      }

      // 2. PUT the file directly to the signed upload URL.
      const putRes = await fetch(started.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!putRes.ok) {
        const body = await putRes.text().catch(() => "");
        console.error("[prep/new] PUT failed", putRes.status, body);
        setError("The file upload failed. Try again.");
        return;
      }

      // 3. Confirm + validate (mime/size/pages) server-side.
      const confirmed = await prepConfirmUpload({ data: { jobId: started.jobId } });
      if (confirmed.error) {
        setError(
          confirmed.error === "validation_failed"
            ? "Unsupported file type or the file could not be read."
            : confirmed.error === "over_limit"
              ? "File exceeds the size or page limit."
              : "Couldn't validate the upload. Try again.",
        );
        return;
      }

      navigate({ to: `/prep/${started.jobId}` });
    } catch (e) {
      console.error("[prep/new] upload failed", e);
      setError("Couldn't complete the upload. Try again.");
    } finally {
      setUploading(false);
    }
  }

  if (!user) {
    return (
      <HostShell>
        <div className="max-w-3xl mx-auto px-6 py-10 space-y-4">
          <p className="font-mono text-xs uppercase tracking-widest text-pink-shock">Sign in</p>
          <p className="text-foreground/70">Sign in to prepare a quiz from source material.</p>
          <Link
            to="/dashboard"
            className="inline-block border border-border px-4 py-2 font-mono text-xs uppercase hover:border-volt hover:text-volt transition-colors"
          >
            Back to dashboard
          </Link>
        </div>
      </HostShell>
    );
  }

  return (
    <HostShell>
      <div className="max-w-2xl mx-auto px-6 py-10 space-y-6">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-volt">
            ✦ Prepare from material
          </p>
          <h1 className="font-display text-4xl italic uppercase mt-1">New quiz prep</h1>
          <p className="mt-2 text-foreground/60">
            Upload a PDF or image. Brain Bolt reads it, maps the content, and drafts source-grounded
            questions for you to review before saving.
          </p>
        </div>

        {error && (
          <div className="border border-pink-shock/40 bg-pink-shock/5 p-4 font-mono text-xs uppercase text-pink-shock">
            {error}
          </div>
        )}

        <div className="border border-border bg-card/40 p-6">
          <p className="font-mono text-[10px] uppercase text-foreground/60 mb-3 block">
            Source file (PDF, PNG, JPEG, WebP · up to 25 MB · up to 200 PDF pages)
          </p>
          <label className="block cursor-pointer">
            <input
              type="file"
              ref={fileInputRef}
              accept=".pdf,.png,.jpg,.jpeg,.webp"
              hidden
              onChange={onFileChange}
            />
            <button
              type="button"
              disabled={uploading || !user}
              onClick={() => fileInputRef.current?.click()}
              className={`w-full flex items-center justify-center gap-3 border rounded-md px-6 py-4 font-mono text-sm uppercase transition-colors ${
                uploading || !user
                  ? "border-border/40 text-foreground/40 cursor-not-allowed"
                  : "border-volt/50 bg-volt/5 hover:border-volt hover:text-volt"
              }`}
            >
              {file
                ? `Change file — ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`
                : "Choose file"}
            </button>
          </label>
          {file && (
            <p className="mt-2 font-mono text-[10px] uppercase text-foreground/40">
              {file.name} · {file.type} · {((file.size / PREP_MAX_FILE_SIZE) * 100).toFixed(1)}% of
              25 MB cap
            </p>
          )}
          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              disabled={uploading || !file || !ACCEPTED_EXTENSIONS.includes(ext(file.name))}
              onClick={onUpload}
              className="bg-volt text-background font-display text-sm uppercase px-6 py-3 skew-cta disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {uploading ? "Uploading…" : "Start preparation"}
            </button>
            <Link
              to="/dashboard"
              className="border border-border px-4 py-3 font-mono text-xs uppercase hover:border-volt hover:text-volt transition-colors"
            >
              Cancel
            </Link>
          </div>
        </div>
      </div>
    </HostShell>
  );
}
