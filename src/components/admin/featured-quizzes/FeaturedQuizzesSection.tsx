"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  adminArenaQuizPublish,
  adminArenaQuizUnpublish,
  adminArenaQuizFeature,
  adminArenaQuizUnfeature,
  adminArenaQuizArchive,
  adminArenaQuizRestore,
  adminArenaQuizHide,
  adminArenaQuizUnhide,
  adminArenaQuizUpdate,
  adminFeaturedQuizMetadataSet,
  adminFeaturedQuizMetadataGet,
} from "@/lib/api/arena-admin.functions";
import { toast } from "sonner";
import { toastError } from "@/lib/errors";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus,
  Trash2,
  Archive,
  RotateCw,
  Eye,
  Edit,
  Publish,
  SendHorizontal,
  Timer,
  Trophy,
  ShieldAlert,
  Loader2,
  ArrowUp,
  ArrowDown,
  Pin,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { difficultyLabel } from "@/lib/terminology";
import { Link } from "@tanstack/react-router";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

type FeaturedQuizEntry = {
  id: string;
  title: string;
  description: string | null;
  difficulty: string | null;
  arena_publication_status: string;
  arena_admin_status: string;
  arena_featured_rank: number | null;
  arena_category: string | null;
  tags: string;
  archived_at: string | null;
  creator_name: string | null;
  play_count: number;
  playable_question_count: number;
  avg_accuracy: number | null;
  last_played_at: string | null;
};

type FeaturedQuizMetadata = {
  source_references: Array<{ url: string; title: string; accessed_at: string }>;
  verification_notes: string;
  verified_through_date: string | null;
  verified_through_at: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

type View = "list" | "edit" | "metadata";

/* ------------------------------------------------------------------ */
/* Schemas                                                            */
/* ------------------------------------------------------------------ */

const updateQuizSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  description: z.string().min(1, "Description is required").max(1000),
  category: z.string().min(1, "Category is required").max(80),
  difficulty: z.enum(["easy", "medium", "hard"]),
  time_per_question: z.coerce.number().int().min(5).max(120).optional(),
  estimated_duration_minutes: z.coerce.number().int().min(1).max(180).optional(),
});

type UpdateQuizValues = z.infer<typeof updateQuizSchema>;

const metadataSchema = z.object({
  source_references: z.string().optional(),
  verification_notes: z.string().max(2000).optional(),
  verified_through_date: z.string().optional(),
});

type MetadataValues = z.infer<typeof metadataSchema>;

/* ------------------------------------------------------------------ */
/* Status helpers                                                     */
/* ------------------------------------------------------------------ */

function statusBadge(status: string) {
  const config: Record<string, { bg: string; text: string; border: string }> = {
    draft: { bg: "bg-background", text: "text-foreground/50", border: "border-border" },
    published: { bg: "bg-volt/10", text: "text-volt", border: "border-volt/30" },
    hidden: { bg: "bg-pink-shock/10", text: "text-pink-shock", border: "border-pink-shock/30" },
    archived: { bg: "bg-foreground/10", text: "text-foreground/40", border: "border-border" },
  };
  const c = config[status] || config.draft;
  return (
    <span
      className={`font-mono text-[9px] uppercase px-2 py-0.5 rounded-md ${c.bg} ${c.text} ${c.border}`}
    >
      {status}
    </span>
  );
}

function featuredBadge(rank: number | null) {
  if (!rank) return null;
  return (
    <span className="font-mono text-[9px] uppercase px-2 py-0.5 rounded-md bg-volt/10 text-volt border border-volt/30">
      Featured #{rank}
    </span>
  );
}

function archivedBadge() {
  return (
    <span className="font-mono text-[9px] uppercase px-2 py-0.5 rounded-md bg-pink-shock/10 text-pink-shock border border-pink-shock/30">
      Archived
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Main section                                                       */
/* ------------------------------------------------------------------ */

export function FeaturedQuizzesSection() {
  const [entries, setEntries] = useState<FeaturedQuizEntry[]>([]);
  const [metadataMap, setMetadataMap] = useState<Map<string, FeaturedQuizMetadata>>(new Map());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [view, setView] = useState<View>("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [metadataViewId, setMetadataViewId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcError } = await (supabase as any).rpc("admin_arena_quizzes", {
        p_status_filter: null,
        p_search: null,
        p_limit: 100,
        p_offset: 0,
      });
      if (rpcError) throw rpcError;
      setEntries((data as FeaturedQuizEntry[] | null) ?? []);
    } catch (err) {
      setError(
        toastError(err, { context: "featured quizzes list", fallback: "Failed to load catalogue" }),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const categories = Array.from(
    new Set(entries.map((e) => e.arena_category).filter(Boolean) as string[]),
  ).sort();

  const filtered = entries.filter((e) => {
    const matchesSearch =
      !search ||
      e.title.toLowerCase().includes(search.toLowerCase()) ||
      (e.description && e.description.toLowerCase().includes(search.toLowerCase())) ||
      (e.arena_category && e.arena_category.toLowerCase().includes(search.toLowerCase()));
    const matchesStatus = !statusFilter || e.arena_publication_status === statusFilter;
    const matchesCategory = !categoryFilter || e.arena_category === categoryFilter;
    return matchesSearch && matchesStatus && matchesCategory;
  });

  /* ------------------------------------------------------------------ */
  /* Actions                                                            */
  /* ------------------------------------------------------------------ */

  const togglePublish = async (id: string, currentlyPublished: boolean) => {
    const fn = currentlyPublished ? adminArenaQuizUnpublish : adminArenaQuizPublish;
    const result = await fn({ p_quiz_id: id });
    if (result.error) {
      toastError(result.error, { context: "publish/unpublish", fallback: "Action failed" });
      return;
    }
    toast.success(currentlyPublished ? "Quiz unpublished" : "Quiz published");
    void loadEntries();
  };

  const toggleFeature = async (id: string, currentlyFeatured: boolean) => {
    if (currentlyFeatured) {
      const result = await adminArenaQuizUnfeature({ p_quiz_id: id });
      if (result.error) {
        toastError(result.error, { context: "unfeature", fallback: "Action failed" });
        return;
      }
      toast.success("Quiz unfeatured");
    } else {
      // Prompt for rank
      const rankInput = prompt("Feature rank (1 = first shown):");
      if (rankInput === null) return;
      const rank = parseInt(rankInput, 10);
      if (!Number.isInteger(rank) || rank < 1 || rank > 1000) {
        toast.error("Invalid rank. Use a number between 1 and 1000.");
        return;
      }
      const result = await adminArenaQuizFeature({ p_quiz_id: id, p_rank: rank });
      if (result.error) {
        toastError(result.error, { context: "feature", fallback: "Action failed" });
        return;
      }
      toast.success(`Quiz featured at rank #${rank}`);
    }
    void loadEntries();
  };

  const toggleArchive = async (id: string, currentlyArchived: boolean) => {
    const fn = currentlyArchived ? adminArenaQuizRestore : adminArenaQuizArchive;
    const result = await fn({ p_quiz_id: id });
    if (result.error) {
      toastError(result.error, { context: "archive/restore", fallback: "Action failed" });
      return;
    }
    toast.success(currentlyArchived ? "Quiz restored" : "Quiz archived");
    void loadEntries();
  };

  const toggleHide = async (id: string, currentlyHidden: boolean) => {
    const fn = currentlyHidden ? adminArenaQuizUnhide : adminArenaQuizHide;
    const result = await fn({ p_quiz_id: id });
    if (result.error) {
      toastError(result.error, { context: "hide/unhide", fallback: "Action failed" });
      return;
    }
    toast.success(currentlyHidden ? "Quiz unhidden" : "Quiz hidden");
    void loadEntries();
  };

  /* ------------------------------------------------------------------ */
  /* Render                                                             */
  /* ------------------------------------------------------------------ */

  if (view === "edit" && editingId) {
    return (
      <EditQuizView
        quizId={editingId}
        entries={entries}
        onBack={() => setView("list")}
        onSave={loadEntries}
        onMetadata={() => setMetadataViewId(editingId)}
      />
    );
  }

  if (view === "metadata" && metadataViewId) {
    return (
      <EditMetadataView
        quizId={metadataViewId}
        entries={entries}
        onBack={() => {
          setMetadataViewId(null);
          setView("list");
        }}
        onSave={loadEntries}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 border border-border bg-background/30 px-3 py-2">
            <label className="font-mono text-[9px] uppercase text-foreground/50">Status</label>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "")}>
              <SelectTrigger className="w-32">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="hidden">Hidden</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 border border-border bg-background/30 px-3 py-2">
            <label className="font-mono text-[9px] uppercase text-foreground/50">Category</label>
            <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v ?? "")}>
              <SelectTrigger className="w-32">
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All</SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            placeholder="Search title, description, category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64 bg-background border border-border px-3 py-2 font-mono text-xs"
          />
        </div>
      </div>

      {error && (
        <div className="border border-pink-shock/50 bg-pink-shock/10 p-4 font-mono text-xs uppercase text-pink-shock">
          {error}
        </div>
      )}

      <div className="border border-border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell className="w-20">ID</TableHeaderCell>
              <TableHeaderCell>Quiz</TableHeaderCell>
              <TableHeaderCell className="w-24">Category</TableHeaderCell>
              <TableHeaderCell className="w-20">Difficulty</TableHeaderCell>
              <TableHeaderCell className="w-20">Status</TableHeaderCell>
              <TableHeaderCell className="w-20">Featured</TableHeaderCell>
              <TableHeaderCell className="w-16">Plays</TableHeaderCell>
              <TableHeaderCell className="w-24">Questions</TableHeaderCell>
              <TableHeaderCell className="w-32">Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={9}>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading catalogue…
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="text-center py-8 text-foreground/50 font-mono text-xs uppercase"
                >
                  No quizzes match these filters.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="font-mono text-xs text-foreground/50 truncate max-w-xs">
                    {entry.id.slice(0, 8)}…
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <p className="font-display text-sm italic uppercase">{entry.title}</p>
                      {entry.description && (
                        <p className="font-mono text-[10px] text-foreground/50 line-clamp-1">
                          {entry.description}
                        </p>
                      )}
                      {entry.creator_name && (
                        <p className="font-mono text-[9px] text-foreground/40 uppercase">
                          By {entry.creator_name}
                        </p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-foreground/60">
                    {entry.arena_category || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-foreground/60 uppercase">
                    {difficultyLabel(entry.difficulty)}
                  </TableCell>
                  <TableCell>{statusBadge(entry.arena_publication_status)}</TableCell>
                  <TableCell>
                    {featuredBadge(entry.arena_featured_rank)}
                    {entry.archived_at && <archivedBadge />}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-foreground/60 tabular-nums">
                    {entry.play_count}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-foreground/60 tabular-nums">
                    {entry.playable_question_count}
                  </TableCell>
                  <TableCell className="flex gap-1">
                    <FeaturedQuizActions
                      entry={entry}
                      onPublish={togglePublish}
                      onFeature={toggleFeature}
                      onArchive={toggleArchive}
                      onHide={toggleHide}
                      onEdit={() => {
                        setEditingId(entry.id);
                        setView("edit");
                      }}
                      onMetadata={() => {
                        setMetadataViewId(entry.id);
                        setView("metadata");
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {entries.length > 0 && (
        <p className="font-mono text-[9px] uppercase tracking-widest text-foreground/50">
          {filtered.length} of {entries.length} quizzes shown
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Helper cell for status header                                      */
/* ------------------------------------------------------------------ */

function TableHeaderCell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "font-mono text-[9px] uppercase tracking-wider text-foreground/40 bg-background/30",
        className,
      )}
    >
      {children}
    </th>
  );
}

/* ------------------------------------------------------------------ */
/* Action buttons per row                                             */
/* ------------------------------------------------------------------ */

type FeaturedQuizActionsProps = {
  entry: FeaturedQuizEntry;
  onPublish: (id: string, currentlyPublished: boolean) => void;
  onFeature: (id: string, currentlyFeatured: boolean) => void;
  onArchive: (id: string, currentlyArchived: boolean) => void;
  onHide: (id: string, currentlyHidden: boolean) => void;
  onEdit: () => void;
  onMetadata: () => void;
};

function FeaturedQuizActions({
  entry,
  onPublish,
  onFeature,
  onArchive,
  onHide,
  onEdit,
  onMetadata,
}: FeaturedQuizActionsProps) {
  const isPublished = entry.arena_publication_status === "published";
  const isFeatured = entry.arena_featured_rank != null;
  const isArchived = entry.archived_at != null;
  const isHidden = entry.arena_admin_status === "hidden";

  return (
    <div className="flex flex-wrap gap-1">
      <Button
        size="sm"
        variant={isPublished ? "default" : "outline"}
        onClick={() => onPublish(entry.id, isPublished)}
        disabled={isArchived}
        className="text-[10px] px-2 py-1"
      >
        {isPublished ? "Unpublish" : "Publish"}
      </Button>
      <Button
        size="sm"
        variant={isFeatured ? "default" : "outline"}
        onClick={() => onFeature(entry.id, isFeatured)}
        disabled={isArchived}
        className="text-[10px] px-2 py-1"
      >
        {isFeatured ? "Unfeature" : "Feature"}
      </Button>
      <Button
        size="sm"
        variant={isArchived ? "default" : "outline"}
        onClick={() => onArchive(entry.id, isArchived)}
        className="text-[10px] px-2 py-1"
      >
        {isArchived ? "Restore" : "Archive"}
      </Button>
      <Button
        size="sm"
        variant={isHidden ? "default" : "outline"}
        onClick={() => onHide(entry.id, isHidden)}
        className="text-[10px] px-2 py-1"
      >
        {isHidden ? "Unhide" : "Hide"}
      </Button>
      <Button size="sm" onClick={onEdit} className="text-[10px] px-2 py-1">
        Edit
      </Button>
      <Button size="sm" onClick={onMetadata} className="text-[10px] px-2 py-1">
        Metadata
      </Button>
      <Link
        to="/quizzes/$id"
        params={{ id: entry.id }}
        target="_blank"
        className="text-[10px] px-2 py-1 border border-border bg-background hover:bg-volt/5 hover:border-volt/50"
      >
        Open editor
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Edit quiz view                                                     */
/* ------------------------------------------------------------------ */

type EditQuizViewProps = {
  quizId: string;
  entries: FeaturedQuizEntry[];
  onBack: () => void;
  onSave: () => void;
  onMetadata: () => void;
};

function EditQuizView({ quizId, entries, onBack, onSave, onMetadata }: EditQuizViewProps) {
  const entry = entries.find((e) => e.id === quizId);
  if (!entry) return null;

  const form = useForm<UpdateQuizValues>({
    resolver: zodResolver(updateQuizSchema),
    defaultValues: {
      title: entry.title ?? "",
      description: entry.description ?? "",
      category: entry.arena_category ?? "",
      difficulty: (entry.difficulty ?? "medium") as "easy" | "medium" | "hard",
      time_per_question: entry.time_per_question ?? undefined,
      estimated_duration_minutes: entry.estimated_duration_minutes ?? undefined,
    },
  });

  const [saving, setSaving] = useState(false);

  const onSubmit = async (values: UpdateQuizValues) => {
    setSaving(true);
    try {
      const result = await adminArenaQuizUpdate({
        p_quiz_id: quizId,
        p_title: values.title,
        p_description: values.description,
        p_category: values.category,
        p_difficulty: values.difficulty,
        p_time_per_question: values.time_per_question,
        p_estimated_duration_minutes: values.estimated_duration_minutes,
      });
      if (result.error) {
        toastError(result.error, { context: "update quiz", fallback: "Update failed" });
        return;
      }
      toast.success("Quiz updated");
      onSave();
      onBack();
    } catch (err) {
      toastError(err, { context: "update quiz", fallback: "Update failed" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          ← Back to catalogue
        </Button>
        <h1 className="font-display text-3xl italic uppercase">Edit: {entry.title}</h1>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="difficulty"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Difficulty</FormLabel>
                  <FormControl asChild>
                    <Select {...field}>
                      <SelectItem value="easy">Easy</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="hard">Hard</SelectItem>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="time_per_question"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Seconds per question</FormLabel>
                  <FormControl>
                    <Input type="number" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="estimated_duration_minutes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Estimated duration (minutes)</FormLabel>
                  <FormControl>
                    <Input type="number" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="border-t border-border pt-6 flex items-center justify-between gap-3">
            <Button type="button" variant="outline" onClick={onBack} className="flex-1">
              Cancel
            </Button>
            <Button size="sm" onClick={onMetadata}>
              Manage metadata →
            </Button>
            <Button type="submit" disabled={saving} className="flex-1 bg-volt text-background">
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Edit metadata view                                                 */
/* ------------------------------------------------------------------ */

type EditMetadataViewProps = {
  quizId: string;
  entries: FeaturedQuizEntry[];
  onBack: () => void;
  onSave: () => void;
};

function EditMetadataView({ quizId, entries, onBack, onSave }: EditMetadataViewProps) {
  const entry = entries.find((e) => e.id === quizId);
  const [metadata, setMetadata] = useState<FeaturedQuizMetadata | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoadingMeta(true);
    void adminFeaturedQuizMetadataGet({ p_quiz_id: quizId })
      .then((res) => {
        if (res.ok && res.metadata) {
          setMetadata(res.metadata);
        }
      })
      .finally(() => setLoadingMeta(false));
  }, [quizId]);

  const form = useForm<MetadataValues>({
    resolver: zodResolver(metadataSchema),
    defaultValues: {
      source_references: "",
      verification_notes: "",
      verified_through_date: "",
    },
  });

  const onSubmit = async (values: MetadataValues) => {
    setSaving(true);
    try {
      const refs: Array<{ url: string; title: string; accessed_at: string }> = [];
      if (values.source_references) {
        try {
          const parsed = JSON.parse(values.source_references);
          if (Array.isArray(parsed)) refs.push(...parsed);
        } catch {
          /* ignore invalid JSON — empty array */
        }
      }

      const result = await adminFeaturedQuizMetadataSet({
        p_quiz_id: quizId,
        p_source_references: refs,
        p_verification_notes: values.verification_notes ?? "",
        p_verified_through_date: values.verified_through_date ?? undefined,
      });
      if (result.error) {
        toastError(result.error, { context: "set metadata", fallback: "Save failed" });
        return;
      }
      toast.success("Metadata saved");
      onSave();
      onBack();
    } catch (err) {
      toastError(err, { context: "set metadata", fallback: "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  if (loadingMeta && !metadata) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <Loader2 className="mb-4 h-6 w-6 animate-spin" />
        <p className="font-mono text-xs uppercase text-foreground/50">Loading metadata…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          ← Back to catalogue
        </Button>
        <h1 className="font-display text-3xl italic uppercase">Metadata: {entry?.title}</h1>
      </div>

      <p className="font-mono text-[10px] uppercase text-foreground/50">
        Source references and verification notes are editorial metadata for featured quizzes. They
        are displayed to players on the quiz detail page where supported.
      </p>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <FormField
            control={form.control}
            name="source_references"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Source references (JSON)</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    placeholder='[{"url": "https://example.com", "title": "Premier League standings", "accessed_at": "2026-10-01T00:00:00Z"}]'
                    rows={4}
                    className="font-mono text-xs"
                  />
                </FormControl>
                <FormMessage />
                <p className="font-mono text-[9px] text-foreground/50">
                  Array of {{ url, title, accessed_at }} objects documenting where each fact was
                  verified.
                </p>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="verification_notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Verification notes</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={4} className="font-mono text-xs" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="verified_through_date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Verified through date</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
                <p className="font-mono text-[9px] text-foreground/50">
                  Displayed to players as "Statistics updated through [date]".
                </p>
              </FormItem>
            )}
          />

          {metadata && (
            <div className="border border-border bg-background/30 p-4 space-y-2">
              <p className="font-mono text-[9px] uppercase text-foreground/50">Current values</p>
              <p className="font-mono text-xs text-foreground/60">
                Verified through:{metadata.verified_through_date || "—"}
              </p>
              <p className="font-mono text-xs text-foreground/60">
                Last updated:{metadata.updated_at || "—"} by {metadata.updated_by || "—"}
              </p>
              <p className="font-mono text-xs text-foreground/60">
                Source references:{metadata.source_references.length}{" "}
                {metadata.source_references.length > 0 ? (
                  <span className="text-volt"> (view in editor)</span>
                ) : null}
              </p>
            </div>
          )}

          <div className="border-t border-border pt-6 flex items-center justify-between gap-3">
            <Button type="button" variant="outline" onClick={onBack} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" disabled={saving} className="flex-1 bg-volt text-background">
              {saving ? "Saving…" : "Save metadata"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
