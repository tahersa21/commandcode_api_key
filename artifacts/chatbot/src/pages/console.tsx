import { useState, useEffect, useCallback, useRef } from "react";
import { useGetChatModels, useGetChatRcModels, useGetChatAgModels } from "@workspace/api-client-react";
import { useAdminAuth, useAdminFetch } from "@/context/admin-auth";
import { useChatStream } from "@/hooks/use-chat-stream";
import { useRightCodeKey } from "@/hooks/use-rightcode-key";
import { useRcPoolStatus } from "@/hooks/use-rc-pool-status";
import { useAiGoCodeKey } from "@/hooks/use-aigocode-key";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectGroup, SelectItem,
  SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Terminal, Lock, Unlock, Plus, Trash2, Copy, CheckCircle2,
  Loader2, ToggleLeft, ToggleRight, RefreshCw, ChevronRight,
  Cpu, Video, Mic, Globe, Key, Send, SquareSquare, Clock,
  AlertTriangle, ExternalLink, Eye, EyeOff, X, Pencil, Sun, Moon,
  GitBranch, GripVertical, ArrowUp, ArrowDown,
} from "lucide-react";
import { useTheme } from "@/context/theme";

// ─── Types ────────────────────────────────────────────────────────────────────

type NavItem = string;

type RoutingProviderEntry = {
  providerType: "cc" | "rc" | "ag" | "custom";
  providerId?: string;
  modelId: string;
  rpmLimit: number;
  priority: number;
};

type RoutingRule = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  providers: RoutingProviderEntry[];
  createdAt: string;
};

type ProviderType = "text" | "video" | "audio";

type CustomProvider = {
  id: string; name: string; slug: string; type: string;
  baseUrl: string; authMethod: string; isActive: boolean;
  channels: { prefix: string; apiType: string; displayName: string }[];
  notes: string | null; createdAt: string;
};

type UserKey = {
  id: string; label: string; key: string; isActive: boolean;
  usageCount: number; lastUsedAt: string | null; createdAt: string;
};

type CcKey = {
  id: string; label: string; key: string; isActive: boolean; isValid: boolean;
  usageCount: number; lastCheckedAt: string | null; createdAt: string;
};

type RcKey = {
  id: string; label: string; key: string; isActive: boolean; isValid: boolean;
  usageCount: number; lastUsedAt: string | null; createdAt: string;
};

function formatMs(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function typeIcon(t: string, size = "w-3.5 h-3.5") {
  if (t === "video") return <Video className={`${size} text-violet-400`} />;
  if (t === "audio") return <Mic className={`${size} text-blue-400`} />;
  return <Cpu className={`${size} text-emerald-400`} />;
}

// ─── Admin Lock Banner ────────────────────────────────────────────────────────

function AdminLockBanner({ onUnlock }: { onUnlock: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/5 border-b border-amber-500/20 text-xs font-sans">
      <Lock className="w-3 h-3 text-amber-400 flex-none" />
      <span className="text-amber-400/80">Management features require admin access.</span>
      <button onClick={onUnlock} className="ml-1 underline text-amber-400 hover:text-amber-300">Unlock</button>
    </div>
  );
}

// ─── Inline Login Dialog ──────────────────────────────────────────────────────

function LoginDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const { login } = useAdminAuth();
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!pw) return;
    setLoading(true); setErr("");
    const res = await login(pw);
    setLoading(false);
    if (res.ok) onSuccess();
    else setErr(res.error ?? "Invalid password");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl p-6 w-80 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-primary" />
            <span className="font-bold text-sm">Admin Access</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="relative">
          <Input
            type={show ? "text" : "password"}
            value={pw} onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            className="h-9 text-sm font-mono pr-9 bg-background/60"
            placeholder="Admin password" autoFocus
          />
          <button onClick={() => setShow(v => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground">
            {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        {err && <p className="text-xs text-destructive font-sans">{err}</p>}
        <Button className="w-full h-9" onClick={submit} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Unlock"}
        </Button>
      </div>
    </div>
  );
}

// ─── Providers Panel ──────────────────────────────────────────────────────────

const BUILTIN_PROVIDERS = [
  {
    slug: "commandcode", name: "CommandCode", type: "text" as ProviderType,
    baseUrl: "https://api.commandcode.ai", note: "Built-in · round-robin key pool",
    detail: "12+ models",
  },
  {
    slug: "rightcode", name: "Right Code", type: "text" as ProviderType,
    baseUrl: "https://right.codes", note: "Built-in · 7 channels",
    detail: "58+ models",
  },
];

function ProvidersPanel({ isAdmin, onProvidersChange }: { isAdmin: boolean; onProvidersChange?: () => void }) {
  const apiFetch = useAdminFetch();
  const [providers, setProviders] = useState<CustomProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", baseUrl: "", apiKey: "" });
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [formErr, setFormErr] = useState("");

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    const res = await apiFetch("/api/admin/providers");
    if (res.ok) {
      const d = await res.json() as { providers: CustomProvider[] };
      setProviders(d.providers ?? []);
    }
    setLoading(false);
  }, [apiFetch, isAdmin]);

  useEffect(() => { load(); }, [load]);

  const slugify = (s: string) => s.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

  const save = async () => {
    if (!form.name.trim() || !form.baseUrl.trim()) {
      setFormErr("الاسم والرابط مطلوبان"); return;
    }
    const slug = slugify(form.name);
    setSaving(true); setFormErr("");
    const res = await apiFetch("/api/admin/providers", {
      method: "POST", body: JSON.stringify({ name: form.name, slug, type: "text", baseUrl: form.baseUrl, authMethod: "bearer", notes: "" }),
    });
    if (res.ok) {
      if (form.apiKey.trim()) localStorage.setItem(`provider_key_${slug}`, form.apiKey.trim());
      setShowForm(false);
      setForm({ name: "", baseUrl: "", apiKey: "" });
      setShowApiKey(false);
      await load();
      onProvidersChange?.();
    } else {
      const d = await res.json() as { error?: string };
      setFormErr(d.error ?? "Failed to save");
    }
    setSaving(false);
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", baseUrl: "" });
  const [editSaving, setEditSaving] = useState(false);

  const startEdit = (p: CustomProvider) => {
    setEditingId(p.id);
    setEditForm({ name: p.name, baseUrl: p.baseUrl });
  };

  const cancelEdit = () => { setEditingId(null); };

  const saveEdit = async (id: string) => {
    if (!editForm.name.trim() || !editForm.baseUrl.trim()) return;
    setEditSaving(true);
    await apiFetch(`/api/admin/providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: editForm.name.trim(), baseUrl: editForm.baseUrl.trim() }),
    });
    setProviders(p => p.map(x => x.id === id ? { ...x, name: editForm.name.trim(), baseUrl: editForm.baseUrl.trim() } : x));
    setEditingId(null);
    setEditSaving(false);
    onProvidersChange?.();
  };

  const toggleActive = async (id: string, cur: boolean) => {
    await apiFetch(`/api/admin/providers/${id}`, { method: "PATCH", body: JSON.stringify({ isActive: !cur }) });
    setProviders(p => p.map(x => x.id === id ? { ...x, isActive: !cur } : x));
  };

  const del = async (id: string) => {
    if (!confirm("Delete this provider?")) return;
    await apiFetch(`/api/admin/providers/${id}`, { method: "DELETE" });
    setProviders(p => p.filter(x => x.id !== id));
  };

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold tracking-tight">Providers</h2>
          <p className="text-[10px] text-muted-foreground font-sans mt-0.5">
            Manage AI providers and their channels
          </p>
        </div>
        {isAdmin && (
          <Button size="sm" className="h-7 px-3 text-xs gap-1.5" onClick={() => setShowForm(v => !v)}>
            <Plus className="w-3.5 h-3.5" /> Add Provider
          </Button>
        )}
      </div>

      {/* Add form */}
      {showForm && (
        <div className="border border-border/60 rounded-lg p-4 bg-card/50 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest">مزوّد جديد</p>
          <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className="h-9 text-sm bg-background/50" placeholder="الاسم (مثال: MyAI)" autoFocus />
          <Input value={form.baseUrl} onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))}
            className="h-9 text-sm font-mono bg-background/50" placeholder="https://api.example.com" />
          <div className="relative">
            <input
              type={showApiKey ? "text" : "password"}
              value={form.apiKey}
              onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
              className="w-full h-9 text-sm font-mono bg-background/50 border border-input rounded-md px-3 pr-9 text-foreground outline-none focus:ring-1 focus:ring-ring"
              placeholder="API Key (اختياري)"
            />
            <button type="button" onClick={() => setShowApiKey(v => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground">
              {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
          {formErr && <p className="text-xs text-destructive font-sans">{formErr}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => { setShowForm(false); setFormErr(""); setShowApiKey(false); }}>
              إلغاء
            </Button>
            <Button size="sm" className="h-8 px-4 text-xs" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "حفظ"}
            </Button>
          </div>
        </div>
      )}

      {/* Built-in providers */}
      <div className="space-y-2">
        <p className="text-[9px] text-muted-foreground/50 uppercase tracking-widest">Built-in</p>
        {BUILTIN_PROVIDERS.map(p => (
          <div key={p.slug} className="flex items-center gap-3 border border-border/40 rounded-lg px-4 py-3 bg-card/20">
            <div className="flex-none">{typeIcon(p.type, "w-4 h-4")}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary/80">{p.type}</span>
              </div>
              <p className="text-[10px] text-muted-foreground font-sans mt-0.5">{p.note} · {p.detail}</p>
            </div>
            <div className="flex-none flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span className="text-[10px] text-emerald-500/80 font-sans">active</span>
            </div>
          </div>
        ))}
      </div>

      {/* Custom providers */}
      {isAdmin && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[9px] text-muted-foreground/50 uppercase tracking-widest">Custom</p>
            <button onClick={load} className="text-muted-foreground/40 hover:text-muted-foreground">
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>

          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
          ) : providers.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground/40 text-xs font-sans">
              No custom providers yet. Click "Add Provider" to get started.
            </div>
          ) : (
            providers.map(p => (
              <div key={p.id} className={`border rounded-lg transition-colors
                ${p.isActive ? "border-border/50 bg-card/30" : "border-border/20 bg-card/10 opacity-60"}`}>
                {editingId === p.id ? (
                  /* ── Edit form ── */
                  <div className="p-3 space-y-2">
                    <p className="text-[9px] text-muted-foreground/50 uppercase tracking-widest">تعديل المزود</p>
                    <Input value={editForm.name}
                      onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                      className="h-8 text-xs bg-background/50" placeholder="الاسم" autoFocus />
                    <Input value={editForm.baseUrl}
                      onChange={e => setEditForm(f => ({ ...f, baseUrl: e.target.value }))}
                      className="h-8 text-xs font-mono bg-background/50" placeholder="https://api.example.com" />
                    <div className="flex justify-end gap-2 pt-1">
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={cancelEdit}>إلغاء</Button>
                      <Button size="sm" className="h-7 px-3 text-xs" onClick={() => saveEdit(p.id)} disabled={editSaving}>
                        {editSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : "حفظ"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  /* ── Normal row ── */
                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-none">{typeIcon(p.type ?? "text", "w-4 h-4")}</div>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{p.name}</span>
                      <p className="text-[10px] text-muted-foreground/60 font-mono mt-0.5 truncate">{p.baseUrl}</p>
                    </div>
                    <div className="flex items-center gap-1 flex-none">
                      <button onClick={() => startEdit(p)}
                        className="p-1.5 rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/20" title="تعديل">
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button onClick={() => toggleActive(p.id, p.isActive)}
                        className="p-1.5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/20">
                        {p.isActive ? <ToggleRight className="w-3.5 h-3.5 text-emerald-500" /> : <ToggleLeft className="w-3.5 h-3.5" />}
                      </button>
                      <button onClick={() => del(p.id)}
                        className="p-1.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {!isAdmin && (
        <div className="text-center py-10 text-muted-foreground/40 text-xs font-sans">
          Unlock admin to manage custom providers.
        </div>
      )}
    </div>
  );
}

// ─── API Keys Panel ───────────────────────────────────────────────────────────

function ApiKeysPanel({ isAdmin }: { isAdmin: boolean }) {
  const apiFetch = useAdminFetch();
  const [keys, setKeys] = useState<UserKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<UserKey | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    const res = await apiFetch("/api/admin/user-keys");
    if (res.ok) { const d = await res.json() as { keys: UserKey[] }; setKeys(d.keys ?? []); }
    setLoading(false);
  }, [apiFetch, isAdmin]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setCreating(true);
    const res = await apiFetch("/api/admin/user-keys", { method: "POST", body: JSON.stringify({ label: newLabel }) });
    const d = await res.json() as { key: UserKey };
    setNewKey(d.key); setNewLabel(""); setShowForm(false);
    await load(); setCreating(false);
  };

  const del = async (id: string) => {
    await apiFetch(`/api/admin/user-keys/${id}`, { method: "DELETE" });
    setKeys(p => p.filter(k => k.id !== id));
  };

  const toggle = async (id: string, cur: boolean) => {
    await apiFetch(`/api/admin/user-keys/${id}`, { method: "PATCH", body: JSON.stringify({ isActive: !cur }) });
    setKeys(p => p.map(k => k.id === id ? { ...k, isActive: !cur } : k));
  };

  const copy = (v: string) => {
    navigator.clipboard.writeText(v);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold tracking-tight">API Keys</h2>
          <p className="text-[10px] text-muted-foreground font-sans mt-0.5">
            Keys for external websites to connect to this API
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={load}>
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
            <Button size="sm" className="h-7 px-3 text-xs gap-1.5" onClick={() => setShowForm(v => !v)}>
              <Plus className="w-3.5 h-3.5" /> Create Key
            </Button>
          </div>
        )}
      </div>

      {/* Usage info */}
      <div className="rounded-lg border border-border/30 bg-card/20 p-4 space-y-1">
        <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Integration</p>
        <p className="text-xs font-sans text-muted-foreground">
          Send the key as <code className="font-mono text-primary/80 bg-primary/5 px-1 rounded">X-Api-Key: sk-cc-...</code> header with each request to{" "}
          <code className="font-mono text-primary/80 bg-primary/5 px-1 rounded">POST /api/chat/stream</code>
        </p>
      </div>

      {showForm && (
        <div className="border border-border/50 rounded-lg p-4 bg-card/50 space-y-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest">New API Key</p>
          <Input value={newLabel} onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") create(); }}
            className="h-8 text-xs font-sans bg-background/50" placeholder="Label (e.g. My Website, App v2)" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button size="sm" className="h-7 px-3 text-xs" onClick={create} disabled={creating}>
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Generate"}
            </Button>
          </div>
        </div>
      )}

      {newKey && (
        <div className="border border-emerald-500/30 bg-emerald-500/5 rounded-lg p-4 space-y-2">
          <p className="text-[10px] text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" /> Key created — copy it now
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-background/50 border border-border/40 rounded px-3 py-2 text-emerald-400 overflow-x-auto">
              {newKey.key}
            </code>
            <Button size="sm" variant="outline" className="h-8 px-2 text-xs gap-1.5 flex-none" onClick={() => copy(newKey.key)}>
              {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
          <button onClick={() => setNewKey(null)} className="text-[10px] text-muted-foreground hover:text-foreground">Dismiss</button>
        </div>
      )}

      {!isAdmin ? (
        <div className="text-center py-10 text-muted-foreground/40 text-xs font-sans">
          Unlock admin to manage API keys.
        </div>
      ) : loading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
      ) : keys.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground/40 text-xs font-sans">
          No API keys yet. Create one to give external apps access.
        </div>
      ) : (
        <div className="space-y-2">
          {keys.map(k => (
            <div key={k.id} className={`border rounded-lg p-3 flex items-center gap-3 transition-colors
              ${k.isActive ? "border-border/50 bg-card/30" : "border-border/30 bg-card/10 opacity-60"}`}>
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{k.label}</span>
                  {!k.isActive && (
                    <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-muted/40 text-muted-foreground">disabled</span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-sans flex-wrap">
                  <code className="font-mono">{k.key}</code>
                  <span>{k.usageCount.toLocaleString()} reqs</span>
                  {k.lastUsedAt && <span>last {new Date(k.lastUsedAt).toLocaleDateString()}</span>}
                  <span>{new Date(k.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-none">
                <button onClick={() => copy(k.key)}
                  className="p-1.5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/20">
                  <Copy className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => toggle(k.id, k.isActive)}
                  className="p-1.5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/20">
                  {k.isActive ? <ToggleRight className="w-3.5 h-3.5 text-emerald-500" /> : <ToggleLeft className="w-3.5 h-3.5" />}
                </button>
                <button onClick={() => del(k.id)}
                  className="p-1.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── CC Keys Panel ────────────────────────────────────────────────────────────

function CcKeysPanel({ isAdmin }: { isAdmin: boolean }) {
  const apiFetch = useAdminFetch();
  const [keys, setKeys] = useState<CcKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState(""); const [keyVal, setKeyVal] = useState(""); const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    const res = await apiFetch("/api/admin/cc-keys");
    if (res.ok) { const d = await res.json() as { keys: CcKey[] }; setKeys(d.keys ?? []); }
    setLoading(false);
  }, [apiFetch, isAdmin]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!keyVal.trim()) return;
    setSaving(true);
    await apiFetch("/api/admin/cc-keys", { method: "POST", body: JSON.stringify({ label, key: keyVal }) });
    setLabel(""); setKeyVal(""); setShowForm(false); await load(); setSaving(false);
  };

  const test = async (id: string) => {
    setTesting(id);
    await apiFetch(`/api/admin/cc-keys/${id}/test`, { method: "POST" });
    await load(); setTesting(null);
  };

  const del = async (id: string) => {
    await apiFetch(`/api/admin/cc-keys/${id}`, { method: "DELETE" });
    setKeys(p => p.filter(k => k.id !== id));
  };

  const toggle = async (id: string, field: "isActive" | "isValid", cur: boolean) => {
    await apiFetch(`/api/admin/cc-keys/${id}`, { method: "PATCH", body: JSON.stringify({ [field]: !cur }) });
    setKeys(p => p.map(k => k.id === id ? { ...k, [field]: !cur } : k));
  };

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold tracking-tight">CommandCode Keys</h2>
          <p className="text-[10px] text-muted-foreground font-sans mt-0.5">Server-side key pool for CC API requests</p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={load}><RefreshCw className="w-3.5 h-3.5" /></Button>
            <Button size="sm" className="h-7 px-3 text-xs gap-1.5" onClick={() => setShowForm(v => !v)}>
              <Plus className="w-3.5 h-3.5" /> Add Key
            </Button>
          </div>
        )}
      </div>

      {showForm && (
        <div className="border border-border/50 rounded-lg p-4 bg-card/50 space-y-2">
          <div className="flex gap-2">
            <Input value={label} onChange={e => setLabel(e.target.value)}
              className="text-xs font-sans h-8 bg-background/50 flex-[0_0_140px]" placeholder="Label" />
            <div className="relative flex-1">
              <Input type={showKey ? "text" : "password"} value={keyVal}
                onChange={e => setKeyVal(e.target.value)} onKeyDown={e => { if (e.key === "Enter") add(); }}
                className="text-xs font-mono h-8 bg-background/50 pr-8" placeholder="cc-..." />
              <button onClick={() => setShowKey(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground">
                {showKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button size="sm" className="h-7 px-3 text-xs" onClick={add} disabled={saving || !keyVal.trim()}>
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Add"}
            </Button>
          </div>
        </div>
      )}

      {!isAdmin ? (
        <div className="text-center py-10 text-muted-foreground/40 text-xs font-sans">Unlock admin to manage CC keys.</div>
      ) : loading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
      ) : keys.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground/40 text-xs font-sans">No CC keys yet. Using env COMMANDCODE_API_KEY fallback.</div>
      ) : (
        <div className="space-y-2">
          {keys.map(k => (
            <div key={k.id} className={`border rounded-lg p-3 flex items-center gap-3 ${k.isActive && k.isValid ? "border-border/50 bg-card/30" : "border-border/30 bg-card/10 opacity-60"}`}>
              <div className="flex-none flex flex-col items-center gap-0.5">
                <div className={`w-1.5 h-1.5 rounded-full ${k.isActive ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
                <div className={`w-1.5 h-1.5 rounded-full ${k.isValid ? "bg-blue-500" : "bg-destructive/70"}`} title={k.isValid ? "valid" : "invalid"} />
              </div>
              <div className="flex-1 min-w-0 space-y-0.5">
                <span className="text-xs font-medium">{k.label}</span>
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-sans">
                  <span>{k.usageCount.toLocaleString()} reqs</span>
                  {k.lastCheckedAt && <span>checked {new Date(k.lastCheckedAt).toLocaleDateString()}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-none">
                <button onClick={() => test(k.id)} disabled={testing === k.id}
                  className="p-1.5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/20 text-[10px] font-sans flex items-center gap-1">
                  {testing === k.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                </button>
                <button onClick={() => toggle(k.id, "isActive", k.isActive)}
                  className="p-1.5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/20">
                  {k.isActive ? <ToggleRight className="w-3.5 h-3.5 text-emerald-500" /> : <ToggleLeft className="w-3.5 h-3.5" />}
                </button>
                <button onClick={() => del(k.id)} className="p-1.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── RC Keys Panel ────────────────────────────────────────────────────────────

function RcKeysPanel({ isAdmin }: { isAdmin: boolean }) {
  const apiFetch = useAdminFetch();
  const [keys, setKeys] = useState<RcKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState(""); const [keyVal, setKeyVal] = useState(""); const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    const res = await apiFetch("/api/admin/rc-keys");
    if (res.ok) { const d = await res.json() as { keys: RcKey[] }; setKeys(d.keys ?? []); }
    setLoading(false);
  }, [apiFetch, isAdmin]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!keyVal.trim()) return;
    setSaving(true);
    await apiFetch("/api/admin/rc-keys", { method: "POST", body: JSON.stringify({ label, key: keyVal }) });
    setLabel(""); setKeyVal(""); setShowForm(false); await load(); setSaving(false);
  };

  const del = async (id: string) => {
    await apiFetch(`/api/admin/rc-keys/${id}`, { method: "DELETE" });
    setKeys(p => p.filter(k => k.id !== id));
  };

  const toggle = async (id: string, cur: boolean) => {
    await apiFetch(`/api/admin/rc-keys/${id}`, { method: "PATCH", body: JSON.stringify({ isActive: !cur }) });
    setKeys(p => p.map(k => k.id === id ? { ...k, isActive: !cur } : k));
  };

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold tracking-tight">Right Code Keys</h2>
          <p className="text-[10px] text-muted-foreground font-sans mt-0.5">Server-side pool for right.codes API requests</p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={load}><RefreshCw className="w-3.5 h-3.5" /></Button>
            <Button size="sm" className="h-7 px-3 text-xs gap-1.5" onClick={() => setShowForm(v => !v)}>
              <Plus className="w-3.5 h-3.5" /> Add Key
            </Button>
          </div>
        )}
      </div>

      {showForm && (
        <div className="border border-border/50 rounded-lg p-4 bg-card/50 space-y-2">
          <div className="flex gap-2">
            <Input value={label} onChange={e => setLabel(e.target.value)}
              className="text-xs font-sans h-8 bg-background/50 flex-[0_0_140px]" placeholder="Label" />
            <div className="relative flex-1">
              <Input type={showKey ? "text" : "password"} value={keyVal}
                onChange={e => setKeyVal(e.target.value)} onKeyDown={e => { if (e.key === "Enter") add(); }}
                className="text-xs font-mono h-8 bg-background/50 pr-8" placeholder="right.codes key..." />
              <button onClick={() => setShowKey(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground">
                {showKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button size="sm" className="h-7 px-3 text-xs" onClick={add} disabled={saving || !keyVal.trim()}>
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Add"}
            </Button>
          </div>
        </div>
      )}

      {!isAdmin ? (
        <div className="text-center py-10 text-muted-foreground/40 text-xs font-sans">Unlock admin to manage RC keys.</div>
      ) : loading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
      ) : keys.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground/40 text-xs font-sans">No RC server keys. Users can provide their own via X-Rightcode-Key.</div>
      ) : (
        <div className="space-y-2">
          {keys.map(k => (
            <div key={k.id} className={`border rounded-lg p-3 flex items-center gap-3 ${k.isActive && k.isValid ? "border-border/50 bg-card/30" : "border-border/30 bg-card/10 opacity-60"}`}>
              <div className="flex-none flex flex-col gap-0.5">
                <div className={`w-1.5 h-1.5 rounded-full ${k.isActive ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
                <div className={`w-1.5 h-1.5 rounded-full ${k.isValid ? "bg-blue-500" : "bg-destructive/70"}`} />
              </div>
              <div className="flex-1 min-w-0 space-y-0.5">
                <span className="text-xs font-medium">{k.label}</span>
                <div className="flex gap-3 text-[10px] text-muted-foreground font-sans">
                  <span>{k.usageCount.toLocaleString()} reqs</span>
                  {k.lastUsedAt && <span>last {new Date(k.lastUsedAt).toLocaleDateString()}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-none">
                <button onClick={() => toggle(k.id, k.isActive)}
                  className="p-1.5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/20">
                  {k.isActive ? <ToggleRight className="w-3.5 h-3.5 text-emerald-500" /> : <ToggleLeft className="w-3.5 h-3.5" />}
                </button>
                <button onClick={() => del(k.id)} className="p-1.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Test Chat Panel ──────────────────────────────────────────────────────────

function TestChatPanel() {
  const { data: ccData } = useGetChatModels();
  const [provider, setProvider] = useState<"cc" | "rc" | "ag">("cc");
  const isRc = provider === "rc";
  const isAg = provider === "ag";
  const { data: rcData } = useGetChatRcModels({ query: { queryKey: ["/api/chat/rc-models"], enabled: isRc, staleTime: 600_000, retry: false } });
  const { hasPoolKeys } = useRcPoolStatus();
  const { key: rcKey } = useRightCodeKey();
  const { key: agKey } = useAiGoCodeKey();
  const { data: agData } = useGetChatAgModels({ query: { queryKey: ["/api/chat/ag-models", agKey], enabled: isAg && !!agKey, staleTime: 600_000, retry: false } });

  const ccModels = ccData?.models ?? [];
  const rcModels = rcData?.models ?? [];
  const agModels = agData?.models ?? [];
  const models = isRc ? rcModels : isAg ? agModels : ccModels;

  const [selectedModel, setSelectedModel] = useState("");
  const [input, setInput] = useState("");
  const { messages, isStreaming, elapsedMs, error: chatError, sendMessage, stopStreaming, clearMessages } = useChatStream();
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (models.length > 0 && (!selectedModel || !models.find(m => m.id === selectedModel))) {
      setSelectedModel(models[0].id);
    }
  }, [models, selectedModel]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isStreaming]);

  const send = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    const extraHeaders: Record<string, string> = {};
    if (isRc && rcKey) extraHeaders["X-Rightcode-Key"] = rcKey;
    if (isAg && agKey) extraHeaders["X-Aigocode-Key"] = agKey;
    await sendMessage(text, selectedModel, "", extraHeaders, []);
  };

  const grouped = models.reduce<Record<string, typeof models>>((acc, m) => {
    const g = m.group ?? "Models";
    if (!acc[g]) acc[g] = [];
    acc[g].push(m);
    return acc;
  }, {});

  const isRTL = (t: string) => /[\u0600-\u06FF]/.test(t);
  const isClaudeOfficial = selectedModel.startsWith("rc:/claude|");

  return (
    <div className="flex flex-col h-full border-l border-border/50 bg-card/10">
      {/* Test Chat Header */}
      <div className="flex-none px-3 py-2 border-b border-border/40 bg-card/30">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[9px] uppercase tracking-widest text-muted-foreground/50 font-sans">Test Chat</span>
          <button onClick={clearMessages} title="Clear" className="text-muted-foreground/30 hover:text-muted-foreground">
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
        {/* Provider toggle */}
        <div className="flex items-center rounded border border-border/50 bg-background/40 p-0.5 gap-0.5 mb-2">
          <button onClick={() => setProvider("cc")} disabled={isStreaming}
            className={`flex-1 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded transition-all
              ${provider === "cc" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            CC
          </button>
          <button onClick={() => setProvider("rc")} disabled={isStreaming}
            className={`flex-1 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded transition-all
              ${provider === "rc" ? "bg-violet-600 text-white shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            RC
          </button>
          <button onClick={() => setProvider("ag")} disabled={isStreaming}
            className={`flex-1 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded transition-all
              ${provider === "ag" ? "bg-cyan-600 text-white shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            AG
          </button>
        </div>
        {/* Model select */}
        <Select value={selectedModel} onValueChange={setSelectedModel} disabled={isStreaming}>
          <SelectTrigger className="h-7 text-[10px] font-mono bg-background/50 border-border/40">
            <SelectValue placeholder="Select model…" />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            {Object.entries(grouped).map(([grp, ms]) => (
              <SelectGroup key={grp}>
                <SelectLabel className="text-[9px] uppercase tracking-wider">{grp}</SelectLabel>
                {ms.map(m => (
                  <SelectItem key={m.id} value={m.id} className="text-[10px] font-mono">
                    {m.name ?? m.id}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        {/* Status */}
        <div className="mt-1.5 flex items-center gap-1.5">
          {isAg ? (
            agKey
              ? <span className="text-[9px] font-sans text-cyan-400/70 flex items-center gap-1"><Key className="w-2.5 h-2.5" />AG key set</span>
              : <span className="text-[9px] font-sans text-amber-400/60 flex items-center gap-1"><Key className="w-2.5 h-2.5" />no AG key</span>
          ) : isRc ? (
            rcKey
              ? <span className="text-[9px] font-sans text-violet-400/70 flex items-center gap-1"><Key className="w-2.5 h-2.5" />key set</span>
              : hasPoolKeys
                ? <span className="text-[9px] font-sans text-emerald-500/60 flex items-center gap-1"><Key className="w-2.5 h-2.5" />server key</span>
                : <span className="text-[9px] font-sans text-amber-400/60 flex items-center gap-1"><Key className="w-2.5 h-2.5" />no key</span>
          ) : (
            <span className="text-[9px] font-sans text-muted-foreground/40 flex items-center gap-1"><Key className="w-2.5 h-2.5" />server pool</span>
          )}
          {isStreaming && (
            <span className="text-[9px] font-sans text-primary/60 flex items-center gap-1 animate-pulse">
              <Clock className="w-2.5 h-2.5" />{formatMs(elapsedMs)}
            </span>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3 text-xs">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground/30 space-y-2 py-8">
            <Terminal className="w-6 h-6 opacity-30" />
            <p className="text-[10px] font-sans">Send a message to test the provider</p>
          </div>
        ) : (
          messages.map((msg, idx) => {
            const isLast = msg.role === "assistant" && idx === messages.length - 1;
            const hasError = isLast && !isStreaming && chatError;
            if (hasError && !msg.content) {
              return (
                <div key={msg.id} className="flex flex-col gap-1 items-start">
                  <span className="text-[9px] text-muted-foreground/40 uppercase tracking-wider px-0.5">Assistant</span>
                  <div className="rounded-lg border border-destructive/30 bg-destructive/8 flex items-start gap-2 px-3 py-2 max-w-full">
                    <AlertTriangle className="w-3 h-3 text-destructive/70 flex-none mt-0.5" />
                    <span className="text-[10px] font-mono text-destructive/80 break-all leading-relaxed">{chatError}</span>
                  </div>
                </div>
              );
            }
            return (
              <div key={msg.id} className={`flex flex-col gap-0.5 ${msg.role === "user" ? "items-end" : "items-start"}`}>
                <span className="text-[9px] text-muted-foreground/40 uppercase tracking-wider px-0.5">
                  {msg.role === "user" ? "You" : "Assistant"}
                  {msg.elapsedMs != null && (
                    <span className="ml-1 text-muted-foreground/30 normal-case tracking-normal">{formatMs(msg.elapsedMs)}</span>
                  )}
                </span>
                <div className={`max-w-[90%] rounded-lg text-[11px] leading-relaxed whitespace-pre-wrap overflow-hidden
                  ${msg.role === "user"
                    ? "px-3 py-2 bg-primary/10 border border-primary/20 text-primary-foreground"
                    : "bg-card border border-border/40 text-card-foreground"}`}
                  dir={isRTL(msg.content) ? "rtl" : "ltr"}
                  style={{ fontFamily: msg.role === "assistant" ? "var(--font-mono)" : "var(--font-sans)" }}>
                  {msg.role === "assistant" ? (
                    <>
                      {msg.content && <div className="px-3 py-2">{msg.content}</div>}
                      {!msg.content && isStreaming && isLast && (
                        <div className="px-3 py-2">
                          <span className="inline-flex gap-0.5 text-muted-foreground/40">
                            <span className="w-1 h-1 rounded-full bg-current animate-bounce [animation-delay:0ms]" />
                            <span className="w-1 h-1 rounded-full bg-current animate-bounce [animation-delay:150ms]" />
                            <span className="w-1 h-1 rounded-full bg-current animate-bounce [animation-delay:300ms]" />
                          </span>
                        </div>
                      )}
                      {hasError && msg.content && (
                        <div className="border-t border-destructive/20 bg-destructive/5 flex items-start gap-2 px-3 py-2">
                          <AlertTriangle className="w-3 h-3 text-destructive/70 flex-none mt-0.5" />
                          <span className="text-[10px] font-mono text-destructive/80 break-all">{chatError}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="px-3 py-2">{msg.content}</div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Claude Official warning */}
      {isClaudeOfficial && (
        <div className="flex-none mx-3 mb-1 flex items-start gap-1.5 rounded border border-orange-500/20 bg-orange-500/5 px-2.5 py-1.5 text-[9px] text-orange-400/70 font-sans">
          <AlertTriangle className="w-3 h-3 flex-none text-orange-400 mt-0.5" />
          <span>Claude Official يتطلب CLI session. جرّب <button
            onClick={() => { const m = models.find(x => x.id.startsWith("rc:/claude-aws|")); if (m) setSelectedModel(m.id); }}
            className="underline hover:text-orange-300">Claude (AWS)</button> بدلاً منه.</span>
        </div>
      )}

      {/* Input */}
      <div className="flex-none px-3 pb-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`; }}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder="Type to test…"
            disabled={isStreaming}
            rows={1}
            className="flex-1 resize-none rounded-lg bg-card border border-border/50 px-3 py-2 text-xs font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/40 min-h-[36px] max-h-[120px]"
          />
          {isStreaming ? (
            <Button size="icon" variant="destructive" className="h-9 w-9 flex-none rounded-lg" onClick={stopStreaming}>
              <SquareSquare className="w-3.5 h-3.5" />
            </Button>
          ) : (
            <Button size="icon" className="h-9 w-9 flex-none rounded-lg" onClick={send} disabled={!input.trim()}>
              <Send className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Custom Provider Key Panel ────────────────────────────────────────────────

type FetchedModel = { id: string; owned_by?: string };

// ─── Pool key stored in localStorage ─────────────────────────────────────────
type PoolKeyApiType = "auto" | "openai" | "codex" | "anthropic";
type PoolKey = { id: string; label: string; key: string; isActive: boolean; apiType?: PoolKeyApiType };

const API_TYPE_LABELS: Record<PoolKeyApiType, string> = {
  auto: "Auto",
  openai: "OpenAI",
  codex: "Codex",
  anthropic: "Anthropic",
};
const API_TYPE_COLORS: Record<PoolKeyApiType, string> = {
  auto: "bg-violet-500/10 text-violet-400",
  openai: "bg-emerald-500/10 text-emerald-400",
  codex: "bg-blue-500/10 text-blue-400",
  anthropic: "bg-amber-500/10 text-amber-400",
};

function loadPoolKeys(slug: string): PoolKey[] {
  try {
    const raw = localStorage.getItem(`provider_keys_${slug}`);
    if (raw) return JSON.parse(raw) as PoolKey[];
    // migrate legacy single key
    const legacy = localStorage.getItem(`provider_key_${slug}`);
    if (legacy) {
      const migrated: PoolKey[] = [{ id: crypto.randomUUID(), label: "Key 1", key: legacy, isActive: true }];
      localStorage.setItem(`provider_keys_${slug}`, JSON.stringify(migrated));
      localStorage.removeItem(`provider_key_${slug}`);
      return migrated;
    }
  } catch { /* ignore */ }
  return [];
}

function savePoolKeys(slug: string, keys: PoolKey[]) {
  localStorage.setItem(`provider_keys_${slug}`, JSON.stringify(keys));
}

function maskKey(k: string) {
  if (k.length <= 8) return "••••••••";
  return k.slice(0, 6) + "•".repeat(Math.min(k.length - 9, 20)) + k.slice(-3);
}

// ─── Custom Provider Key Panel ────────────────────────────────────────────────

function CustomProviderKeyPanel({ provider }: { provider: CustomProvider }) {
  const apiFetch = useAdminFetch();

  // ── Key pool ──
  const [keys, setKeys] = useState<PoolKey[]>(() => loadPoolKeys(provider.slug));
  const [showForm, setShowForm] = useState(false);
  const [formLabel, setFormLabel] = useState("");
  const [formKey, setFormKey] = useState("");
  const [formApiType, setFormApiType] = useState<PoolKeyApiType>("auto");
  const [showFormKey, setShowFormKey] = useState(false);
  const [copiedKeyId, setCopiedKeyId] = useState("");

  const persist = (next: PoolKey[]) => { setKeys(next); savePoolKeys(provider.slug, next); };

  const addKey = () => {
    if (!formKey.trim()) return;
    const label = formLabel.trim() || `Key ${keys.length + 1}`;
    persist([...keys, { id: crypto.randomUUID(), label, key: formKey.trim(), isActive: true, apiType: formApiType }]);
    setFormLabel(""); setFormKey(""); setFormApiType("auto"); setShowForm(false); setShowFormKey(false);
  };

  const delKey = (id: string) => persist(keys.filter(k => k.id !== id));

  const toggleKey = (id: string) =>
    persist(keys.map(k => k.id === id ? { ...k, isActive: !k.isActive } : k));

  const copyKey = (id: string, val: string) => {
    navigator.clipboard.writeText(val).catch(() => {});
    setCopiedKeyId(id);
    setTimeout(() => setCopiedKeyId(""), 1500);
  };

  // ── Models ──
  type KeyModels = { keyId: string; keyLabel: string; models: FetchedModel[]; detectedPath: string; error?: string };
  const [keyModels, setKeyModels] = useState<KeyModels[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsFetched, setModelsFetched] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [copiedModelId, setCopiedModelId] = useState("");

  const fetchModels = async () => {
    const activeKeys = loadPoolKeys(provider.slug).filter(k => k.isActive);
    const keysToTry = activeKeys.length > 0
      ? activeKeys.map(k => ({ id: k.id, label: k.label, key: k.key }))
      : [{ id: "__no-key__", label: "بدون مفتاح", key: "" }];
    setFetchingModels(true); setKeyModels([]);
    const results = await Promise.all(
      keysToTry.map(k =>
        apiFetch("/api/admin/provider-models", {
          method: "POST",
          body: JSON.stringify({ baseUrl: provider.baseUrl, apiKey: k.key || undefined }),
        }).then(async res => {
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
            return { keyId: k.id, keyLabel: k.label, models: [] as FetchedModel[], detectedPath: "", error: err.error ?? `HTTP ${res.status}` };
          }
          const data = await res.json() as { models: FetchedModel[]; detectedPath?: string };
          return { keyId: k.id, keyLabel: k.label, models: (data.models ?? []).sort((a, b) => a.id.localeCompare(b.id)), detectedPath: data.detectedPath ?? "" };
        }).catch((e: unknown) => ({ keyId: k.id, keyLabel: k.label, models: [] as FetchedModel[], detectedPath: "", error: String(e).slice(0, 80) }))
      )
    );
    setKeyModels(results);
    setModelsFetched(true);
    if (results.length > 0) setExpandedKey(results[0].keyId);
    setFetchingModels(false);
  };

  const copyModelId = (id: string) => {
    navigator.clipboard.writeText(id).catch(() => {});
    setCopiedModelId(id);
    setTimeout(() => setCopiedModelId(""), 1500);
  };

  const activeCount = keys.filter(k => k.isActive).length;

  return (
    <div className="p-6 space-y-5 max-w-3xl">
      {/* Header */}
      <div>
        <h2 className="text-sm font-bold tracking-tight">{provider.name} — API Keys</h2>
        <p className="text-[10px] text-muted-foreground/60 font-mono mt-0.5 truncate">{provider.baseUrl}</p>
      </div>

      {/* Key pool */}
      <div className="border border-border/50 rounded-lg bg-card/30 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
          <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1.5">
            <Key className="w-3 h-3" /> API Keys
            {keys.length > 0 && (
              <span className="normal-case tracking-normal font-sans text-muted-foreground/50">
                ({activeCount} نشط / {keys.length} إجمالي)
              </span>
            )}
          </label>
          <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs gap-1"
            onClick={() => setShowForm(v => !v)}>
            <Plus className="w-3 h-3" /> إضافة مفتاح
          </Button>
        </div>

        {/* Add form */}
        {showForm && (
          <div className="px-4 py-3 space-y-2 border-b border-border/30 bg-card/50">
            <Input value={formLabel} onChange={e => setFormLabel(e.target.value)}
              className="h-8 text-xs bg-background/50" placeholder="التسمية (اختياري)" />
            <div className="relative">
              <input type={showFormKey ? "text" : "password"} value={formKey}
                onChange={e => setFormKey(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") addKey(); }}
                className="w-full h-8 text-xs font-mono bg-background/50 border border-input rounded-md px-3 pr-8 text-foreground outline-none focus:ring-1 focus:ring-ring"
                placeholder={`${provider.name} API key...`} autoFocus />
              <button type="button" onClick={() => setShowFormKey(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground">
                {showFormKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
            {/* Connection type */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground/50 font-sans w-24 flex-none">نوع الاتصال</span>
              <select value={formApiType} onChange={e => setFormApiType(e.target.value as PoolKeyApiType)}
                className="flex-1 h-7 rounded-md border border-border/40 bg-background/60 text-xs px-2 font-mono focus:outline-none focus:ring-1 focus:ring-primary/50">
                <option value="auto">Auto (يجرّب تلقائياً)</option>
                <option value="openai">OpenAI Completions (/v1/chat/completions)</option>
                <option value="codex">Codex Responses (/v1/responses)</option>
                <option value="anthropic">Anthropic Messages (/v1/messages)</option>
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" className="h-7 text-xs"
                onClick={() => { setShowForm(false); setFormLabel(""); setFormKey(""); setFormApiType("auto"); setShowFormKey(false); }}>
                إلغاء
              </Button>
              <Button size="sm" className="h-7 px-3 text-xs" onClick={addKey} disabled={!formKey.trim()}>
                حفظ
              </Button>
            </div>
          </div>
        )}

        {/* Keys list */}
        {keys.length === 0 ? (
          <p className="text-[10px] text-muted-foreground/40 font-sans text-center py-6">
            لا توجد مفاتيح بعد. اضغط "إضافة مفتاح" للبدء.
          </p>
        ) : (
          <div className="divide-y divide-border/20">
            {keys.map((k, i) => (
              <div key={k.id} className={`flex items-center gap-3 px-4 py-2.5 transition-colors
                ${k.isActive ? "" : "opacity-50"}`}>
                <div className="flex-none w-4 text-[9px] text-muted-foreground/30 text-center">{i + 1}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium">{k.label}</span>
                    {i === 0 && k.isActive && (
                      <span className="text-[8px] uppercase tracking-wider px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-500/70">primary</span>
                    )}
                    {k.apiType && (
                      <span className={`text-[8px] uppercase tracking-wider px-1 py-0.5 rounded ${API_TYPE_COLORS[k.apiType]}`}>
                        {API_TYPE_LABELS[k.apiType]}
                      </span>
                    )}
                  </div>
                  <code className="text-[10px] text-muted-foreground/50 font-mono">{maskKey(k.key)}</code>
                </div>
                <div className="flex items-center gap-0.5 flex-none">
                  <button onClick={() => copyKey(k.id, k.key)}
                    className="p-1.5 rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/20" title="نسخ">
                    {copiedKeyId === k.id ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                  </button>
                  <button onClick={() => toggleKey(k.id)}
                    className="p-1.5 rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/20">
                    {k.isActive ? <ToggleRight className="w-3.5 h-3.5 text-emerald-500" /> : <ToggleLeft className="w-3.5 h-3.5" />}
                  </button>
                  <button onClick={() => delKey(k.id)}
                    className="p-1.5 rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Fetch Models */}
      <div className="border border-border/40 rounded-lg bg-card/20 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
          <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1.5">
            <SquareSquare className="w-3 h-3" />
            النماذج المتاحة
            {modelsFetched && keyModels.length > 0 && (
              <span className="normal-case tracking-normal text-primary/70 font-sans ml-1">
                ({keyModels.reduce((s, r) => s + r.models.length, 0)} نموذج)
              </span>
            )}
          </label>
          <Button size="sm" variant="outline" className="h-7 px-3 text-xs gap-1.5"
            onClick={fetchModels} disabled={fetchingModels}>
            {fetchingModels
              ? <><Loader2 className="w-3 h-3 animate-spin" /> جاري الجلب…</>
              : <><RefreshCw className="w-3 h-3" /> جلب النماذج</>}
          </Button>
        </div>

        {/* Empty hint */}
        {!modelsFetched && !fetchingModels && (
          <p className="text-[10px] text-muted-foreground/40 font-sans px-4 py-5 text-center">
            اضغط "جلب النماذج" لعرض النماذج المتاحة لكل مفتاح.
          </p>
        )}

        {/* Per-key accordions */}
        {modelsFetched && keyModels.length > 0 && (
          <div className="divide-y divide-border/20">
            {keyModels.map((kr, idx) => {
              const isOpen = expandedKey === kr.keyId;
              const hasError = !!kr.error;
              const count = kr.models.length;
              return (
                <div key={kr.keyId}>
                  {/* Accordion header */}
                  <button
                    onClick={() => setExpandedKey(isOpen ? null : kr.keyId)}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/10 transition-colors text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <ChevronRight className={`w-3 h-3 flex-none text-muted-foreground/50 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                      <span className="text-xs font-medium truncate">{kr.keyLabel || `Key ${idx + 1}`}</span>
                      {idx === 0 && (
                        <span className="text-[8px] uppercase tracking-wider px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-500/70 flex-none">primary</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-none ml-2">
                      {kr.detectedPath && (
                        <span className="text-[9px] font-mono text-muted-foreground/40 hidden sm:block">{kr.detectedPath}</span>
                      )}
                      {hasError ? (
                        <span className="text-[9px] text-destructive/70 bg-destructive/10 px-1.5 py-0.5 rounded">خطأ</span>
                      ) : (
                        <span className="text-[9px] text-primary/60 bg-primary/10 px-1.5 py-0.5 rounded font-mono">{count}</span>
                      )}
                    </div>
                  </button>

                  {/* Expanded models list */}
                  {isOpen && (
                    <div className="px-3 pb-3">
                      {hasError ? (
                        <div className="text-[10px] text-destructive/80 bg-destructive/10 border border-destructive/20 rounded-md p-2 font-sans">
                          {kr.error}
                        </div>
                      ) : count === 0 ? (
                        <p className="text-[10px] text-muted-foreground/40 font-sans px-1 py-2">لم يتم العثور على نماذج.</p>
                      ) : (
                        <div className="space-y-1 max-h-64 overflow-y-auto pr-0.5">
                          {kr.models.map(m => (
                            <div key={m.id}
                              className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-md bg-background/40 border border-border/30 hover:border-border/60 transition-colors group">
                              <span className="text-xs font-mono text-foreground/80 truncate">{m.id}</span>
                              <div className="flex items-center gap-2 flex-none">
                                {m.owned_by && (
                                  <span className="text-[9px] text-muted-foreground/40 font-sans hidden group-hover:block">{m.owned_by}</span>
                                )}
                                <button onClick={() => copyModelId(m.id)}
                                  className="text-muted-foreground/30 hover:text-muted-foreground p-0.5 transition-colors">
                                  {copiedModelId === m.id
                                    ? <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                                    : <Copy className="w-3 h-3" />}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Routing Panel ────────────────────────────────────────────────────────────

const PROVIDER_TYPE_LABELS: Record<string, string> = {
  cc: "CommandCode", rc: "Right Code", ag: "AiGoCode", custom: "Custom",
};

const PROVIDER_TYPE_COLORS: Record<string, string> = {
  cc: "text-emerald-400", rc: "text-blue-400", ag: "text-violet-400", custom: "text-amber-400",
};

function RoutingProviderRow({
  entry, index, total, customProviders, adminToken,
  onChange, onRemove, onMoveUp, onMoveDown,
}: {
  entry: RoutingProviderEntry; index: number; total: number;
  customProviders: CustomProvider[]; adminToken: string | null;
  onChange: (e: RoutingProviderEntry) => void;
  onRemove: () => void; onMoveUp: () => void; onMoveDown: () => void;
}) {
  const [browsedModels, setBrowsedModels] = useState<string[]>([]);
  const [browsedModelGroups, setBrowsedModelGroups] = useState<{ keyLabel: string; models: string[]; error?: string }[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node))
        setShowPicker(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPicker]);

  const browseModels = async () => {
    setFetchingModels(true); setBrowseError(""); setBrowsedModels([]); setBrowsedModelGroups([]); setShowPicker(false);
    try {
      let ids: string[] = [];
      if (entry.providerType === "cc") {
        const r = await fetch("/api/chat/models");
        if (r.ok) {
          const d = await r.json() as { models: (string | { id: string })[] };
          ids = d.models.map(m => typeof m === "string" ? m : m.id);
        }
      } else if (entry.providerType === "rc") {
        const r = await fetch("/api/chat/rc-models");
        if (r.ok) {
          const d = await r.json() as { models: { id: string }[] };
          ids = d.models.map(m => m.id);
        }
      } else if (entry.providerType === "ag") {
        const agKey = localStorage.getItem("aigocode_api_key") ?? "";
        const r = await fetch("/api/chat/ag-models", { headers: { "X-Aigocode-Key": agKey } });
        if (r.ok) {
          const d = await r.json() as { models: { id: string }[] };
          ids = d.models.map(m => m.id);
        } else {
          setBrowseError("Add AiGoCode key in settings first");
        }
      } else if (entry.providerType === "custom" && entry.providerId) {
        const provider = customProviders.find(p => p.slug === entry.providerId);
        if (provider) {
          let activeKeys: { id: string; label: string; key: string }[] = [];
          try {
            const raw = localStorage.getItem(`provider_keys_${provider.slug}`);
            if (raw) {
              const poolKeys = JSON.parse(raw) as Array<{ id: string; label: string; key: string; isActive: boolean }>;
              activeKeys = poolKeys.filter(k => k.isActive).map(k => ({ id: k.id, label: k.label, key: k.key }));
            }
          } catch {}
          if (activeKeys.length === 0) {
            const legacy = localStorage.getItem(`provider_key_${provider.slug}`) ?? "";
            if (legacy) activeKeys = [{ id: "__legacy__", label: provider.name, key: legacy }];
          }
          if (activeKeys.length === 0) {
            setBrowseError("Add keys for this provider first");
          } else {
            const results = await Promise.all(
              activeKeys.map(k =>
                fetch("/api/admin/provider-models", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
                  body: JSON.stringify({ baseUrl: provider.baseUrl, apiKey: k.key }),
                }).then(async res => {
                  if (!res.ok) {
                    const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
                    return { keyLabel: k.label, models: [] as string[], error: d.error?.slice(0, 80) ?? `HTTP ${res.status}` };
                  }
                  const d = await res.json() as { models: { id: string }[] };
                  return { keyLabel: k.label, models: (d.models ?? []).map(m => m.id).sort() };
                }).catch((e: unknown) => ({ keyLabel: k.label, models: [] as string[], error: String(e).slice(0, 80) }))
              )
            );
            setBrowsedModelGroups(results);
            const totalCount = results.reduce((n, g) => n + g.models.length, 0);
            if (totalCount > 0) setShowPicker(true);
            else setBrowseError("No models found");
          }
        } else {
          setBrowseError("Select a provider first");
        }
        setFetchingModels(false);
        return;
      }
      setBrowsedModels(ids);
      if (ids.length > 0) setShowPicker(true);
      else if (!browseError) setBrowseError("No models found");
    } catch (e) { setBrowseError(String(e).slice(0, 80)); }
    finally { setFetchingModels(false); }
  };

  const selectDropdownValue = entry.providerType === "custom"
    ? (entry.providerId ?? "__custom__")
    : entry.providerType;

  const handleProviderChange = (val: string) => {
    const builtin = ["cc", "rc", "ag"];
    if (builtin.includes(val)) {
      onChange({ ...entry, providerType: val as "cc" | "rc" | "ag", providerId: undefined, modelId: "" });
    } else {
      onChange({ ...entry, providerType: "custom", providerId: val, modelId: "" });
    }
    setBrowsedModels([]); setShowPicker(false); setBrowseError("");
  };

  const modelPlaceholder =
    entry.providerType === "rc" ? "rc:/codex-pro|gpt-5.4" :
    entry.providerType === "ag" ? "ag:gpt-4o" : "zai-org/GLM-5";

  return (
    <div className="flex items-start gap-2 p-2.5 rounded-lg border border-border/30 bg-background/40">
      <div className="flex flex-col gap-0.5 pt-1">
        <button onClick={onMoveUp} disabled={index === 0}
          className="p-0.5 rounded text-muted-foreground/30 hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed transition-colors">
          <ArrowUp className="w-3 h-3" />
        </button>
        <button onClick={onMoveDown} disabled={index === total - 1}
          className="p-0.5 rounded text-muted-foreground/30 hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed transition-colors">
          <ArrowDown className="w-3 h-3" />
        </button>
      </div>

      <div className="flex-1 space-y-2 min-w-0">
        {/* Provider row */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground/40 w-16 flex-none">Provider</span>
          <select
            value={selectDropdownValue}
            onChange={e => handleProviderChange(e.target.value)}
            className="flex-1 h-7 rounded-md border border-border/40 bg-background/60 text-xs px-2 font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
          >
            <optgroup label="Built-in">
              <option value="cc">CommandCode (CC)</option>
              <option value="rc">Right Code (RC)</option>
              <option value="ag">AiGoCode (AG)</option>
            </optgroup>
            {customProviders.length > 0 && (
              <optgroup label="Custom Providers">
                {customProviders.map(p => (
                  <option key={p.slug} value={p.slug}>{p.name}</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        {/* Model ID + Browse */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground/40 w-16 flex-none">Model ID</span>
          <div className="flex-1 relative" ref={pickerRef}>
            <Input
              value={entry.modelId}
              onChange={e => onChange({ ...entry, modelId: e.target.value })}
              placeholder={modelPlaceholder}
              className="h-7 text-xs font-mono bg-background/60 pr-20"
            />
            <button onClick={browseModels} disabled={fetchingModels}
              className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1 px-2 h-5 rounded text-[9px] text-muted-foreground/50 hover:text-primary/70 hover:bg-primary/10 disabled:opacity-40 transition-colors font-sans">
              {fetchingModels ? <Loader2 className="w-3 h-3 animate-spin" /> : <SquareSquare className="w-3 h-3" />}
              Browse
            </button>

            {/* Model picker */}
            {showPicker && (browsedModels.length > 0 || browsedModelGroups.length > 0) && (
              <div className="absolute top-full left-0 right-0 z-50 mt-1 max-h-52 overflow-y-auto rounded-lg border border-border/50 bg-card shadow-xl">
                <div className="px-2 py-1 border-b border-border/20 flex items-center justify-between sticky top-0 bg-card z-10">
                  <span className="text-[9px] text-muted-foreground/40 font-sans">
                    {browsedModelGroups.length > 0
                      ? `${browsedModelGroups.reduce((n, g) => n + g.models.length, 0)} models · ${browsedModelGroups.length} keys`
                      : `${browsedModels.length} models`}
                  </span>
                  <button onClick={() => setShowPicker(false)} className="text-muted-foreground/30 hover:text-foreground">
                    <X className="w-3 h-3" />
                  </button>
                </div>
                {browsedModelGroups.length > 0 ? (
                  browsedModelGroups.map((group, gi) => (
                    <div key={gi}>
                      <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-muted-foreground/40 font-sans bg-muted/10 border-b border-border/10 flex items-center justify-between">
                        <span>{group.keyLabel}</span>
                        {group.error
                          ? <span className="text-destructive/60">{group.error}</span>
                          : <span>{group.models.length} models</span>}
                      </div>
                      {group.models.map(m => (
                        <button key={m}
                          className="w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-primary/10 hover:text-primary transition-colors truncate"
                          onClick={() => { onChange({ ...entry, modelId: m }); setShowPicker(false); }}>
                          {m}
                        </button>
                      ))}
                    </div>
                  ))
                ) : (
                  browsedModels.map(m => (
                    <button key={m}
                      className="w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-primary/10 hover:text-primary transition-colors truncate"
                      onClick={() => { onChange({ ...entry, modelId: m }); setShowPicker(false); }}>
                      {m}
                    </button>
                  ))
                )}
              </div>
            )}

            {browseError && !showPicker && (
              <p className="absolute top-full left-0 mt-1 text-[9px] text-destructive/70 font-sans whitespace-nowrap">{browseError}</p>
            )}
          </div>
        </div>

        {/* RPM Limit */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground/40 w-16 flex-none">RPM Limit</span>
          <Input
            type="number" min={0}
            value={entry.rpmLimit}
            onChange={e => onChange({ ...entry, rpmLimit: Math.max(0, Number(e.target.value)) })}
            placeholder="0 = unlimited"
            className="h-7 text-xs font-mono bg-background/60 flex-1"
          />
        </div>
      </div>

      <button onClick={onRemove}
        className="p-1 rounded text-muted-foreground/20 hover:text-destructive/70 transition-colors mt-0.5 flex-none">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function RuleEditor({
  rule, rpmStats, customProviders, adminToken, onSave, onCancel,
}: {
  rule: Partial<RoutingRule> & { providers: RoutingProviderEntry[] };
  rpmStats: Record<string, number>;
  customProviders: CustomProvider[];
  adminToken: string | null;
  onSave: (data: { name: string; description: string; providers: RoutingProviderEntry[]; isActive: boolean }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(rule.name ?? "");
  const [description, setDescription] = useState(rule.description ?? "");
  const [providers, setProviders] = useState<RoutingProviderEntry[]>(rule.providers);
  const [isActive, setIsActive] = useState(rule.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const addProvider = () => {
    setProviders(prev => [...prev, { providerType: "cc", modelId: "", rpmLimit: 0, priority: prev.length }]);
  };

  const updateProvider = (i: number, entry: RoutingProviderEntry) => {
    setProviders(prev => prev.map((p, idx) => idx === i ? entry : p));
  };

  const removeProvider = (i: number) => {
    setProviders(prev => prev.filter((_, idx) => idx !== i).map((p, idx) => ({ ...p, priority: idx })));
  };

  const moveProvider = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= providers.length) return;
    const next = [...providers];
    [next[i], next[j]] = [next[j], next[i]];
    setProviders(next.map((p, idx) => ({ ...p, priority: idx })));
  };

  const handleSave = async () => {
    if (!name.trim()) { setErr("Name is required"); return; }
    setSaving(true); setErr("");
    try { await onSave({ name: name.trim(), description, providers, isActive }); }
    catch (e) { setErr(String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">Rule Name</label>
          <Input value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. fast, smart, fallback"
            className="h-8 text-sm font-mono bg-background/60" />
          <p className="text-[9px] text-muted-foreground/40 font-sans">
            Model ID: <span className="font-mono text-primary/50">route:{name || "name"}</span>
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">Description</label>
          <Input value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Optional description"
            className="h-8 text-sm bg-background/60" />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">Active</label>
        <button onClick={() => setIsActive(v => !v)}>
          {isActive
            ? <ToggleRight className="w-6 h-6 text-emerald-500" />
            : <ToggleLeft className="w-6 h-6 text-muted-foreground/40" />}
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider flex items-center gap-1.5">
            <GitBranch className="w-3 h-3" /> Provider Chain (top = highest priority)
          </label>
          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] gap-1" onClick={addProvider}>
            <Plus className="w-3 h-3" /> Add Provider
          </Button>
        </div>

        {providers.length === 0 && (
          <div className="text-[10px] text-muted-foreground/30 font-sans text-center py-4 border border-dashed border-border/30 rounded-lg">
            No providers — add at least one
          </div>
        )}

        <div className="space-y-2">
          {providers.map((entry, i) => (
            <RoutingProviderRow
              key={i} entry={entry} index={i} total={providers.length}
              customProviders={customProviders} adminToken={adminToken}
              onChange={e => updateProvider(i, e)}
              onRemove={() => removeProvider(i)}
              onMoveUp={() => moveProvider(i, -1)}
              onMoveDown={() => moveProvider(i, 1)}
            />
          ))}
        </div>
      </div>

      {err && <p className="text-xs text-destructive font-sans">{err}</p>}

      <div className="flex items-center gap-2 pt-1">
        <Button className="h-8 text-xs gap-1.5" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
          Save Rule
        </Button>
        <Button variant="outline" className="h-8 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function RoutingPanel({ isAdmin, customProviders }: { isAdmin: boolean; customProviders: CustomProvider[] }) {
  const { token } = useAdminAuth();
  const adminFetch = useAdminFetch();
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [rpmStats, setRpmStats] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminFetch("/api/admin/routing-rules");
      if (r.ok) {
        const d = await r.json() as { rules: RoutingRule[]; rpmStats: Record<string, number> };
        setRules(d.rules ?? []);
        setRpmStats(d.rpmStats ?? {});
      }
    } finally { setLoading(false); }
  }, [adminFetch]);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  const copyRouteId = (name: string) => {
    navigator.clipboard.writeText(`route:${name}`).catch(() => {});
    setCopiedId(name);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const toggleActive = async (rule: RoutingRule) => {
    await adminFetch(`/api/admin/routing-rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !rule.isActive }),
    });
    await load();
  };

  const deleteRule = async (id: string) => {
    if (!confirm("Delete this routing rule?")) return;
    await adminFetch(`/api/admin/routing-rules/${id}`, { method: "DELETE" });
    await load();
  };

  const saveNew = async (data: { name: string; description: string; providers: RoutingProviderEntry[]; isActive: boolean }) => {
    const r = await adminFetch("/api/admin/routing-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!r.ok) {
      const d = await r.json() as { error?: string };
      throw new Error(d.error ?? "Failed to create rule");
    }
    setCreating(false);
    await load();
  };

  const saveEdit = async (id: string, data: { name: string; description: string; providers: RoutingProviderEntry[]; isActive: boolean }) => {
    const r = await adminFetch(`/api/admin/routing-rules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!r.ok) {
      const d = await r.json() as { error?: string };
      throw new Error(d.error ?? "Failed to update rule");
    }
    setEditingId(null);
    await load();
  };

  if (!isAdmin) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <GitBranch className="w-4 h-4 text-primary" />
          <span className="text-sm font-bold">Smart Routing</span>
        </div>
        <p className="text-xs text-muted-foreground/50 font-sans">Admin access required to manage routing rules.</p>
      </div>
    );
  }

  return (
    <div className="p-5 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-primary" />
          <span className="text-sm font-bold">Smart Routing</span>
          <span className="text-[10px] text-muted-foreground/40 font-sans ml-1">— priority failover with RPM limits</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-7 px-2 gap-1 text-xs" onClick={load}>
            <RefreshCw className="w-3 h-3" />
          </Button>
          <Button size="sm" className="h-7 px-3 text-xs gap-1.5" onClick={() => { setCreating(true); setEditingId(null); }}>
            <Plus className="w-3 h-3" /> New Rule
          </Button>
        </div>
      </div>

      <div className="text-[10px] text-muted-foreground/40 font-sans bg-muted/10 border border-border/20 rounded-lg px-3 py-2 leading-relaxed">
        Use <span className="font-mono text-primary/60">route:&lt;name&gt;</span> as the model ID in any chat request.
        The engine tries providers top-down, skipping any that exceed their RPM limit.
      </div>

      {creating && (
        <div className="border border-primary/20 rounded-xl bg-card/30 p-4 space-y-3">
          <p className="text-xs font-bold text-primary/70">New Routing Rule</p>
          <RuleEditor
            rule={{ providers: [], isActive: true }}
            rpmStats={rpmStats}
            customProviders={customProviders}
            adminToken={token}
            onSave={saveNew}
            onCancel={() => setCreating(false)}
          />
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-primary/40" />
        </div>
      ) : rules.length === 0 && !creating ? (
        <div className="text-center py-12 text-xs text-muted-foreground/30 font-sans">
          No routing rules yet. Click "New Rule" to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map(rule => (
            <div key={rule.id} className={`border rounded-xl bg-card/20 overflow-hidden transition-colors ${
              rule.isActive ? "border-border/40" : "border-border/20 opacity-60"
            }`}>
              {editingId === rule.id ? (
                <div className="p-4 space-y-3">
                  <p className="text-xs font-bold text-primary/70">Edit Rule</p>
                  <RuleEditor
                    rule={rule}
                    rpmStats={rpmStats}
                    customProviders={customProviders}
                    adminToken={token}
                    onSave={(data) => saveEdit(rule.id, data)}
                    onCancel={() => setEditingId(null)}
                  />
                </div>
              ) : (
                <div className="px-4 py-3 space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <button onClick={() => toggleActive(rule)}>
                        {rule.isActive
                          ? <ToggleRight className="w-5 h-5 text-emerald-500 flex-none" />
                          : <ToggleLeft className="w-5 h-5 text-muted-foreground/30 flex-none" />}
                      </button>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold truncate">{rule.name}</span>
                          {!rule.isActive && (
                            <span className="text-[9px] uppercase tracking-wider text-muted-foreground/40 bg-muted/20 px-1.5 py-0.5 rounded flex-none">disabled</span>
                          )}
                        </div>
                        {rule.description && (
                          <p className="text-[10px] text-muted-foreground/50 font-sans truncate">{rule.description}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-none">
                      <button onClick={() => copyRouteId(rule.name)}
                        className="flex items-center gap-1 text-[9px] font-mono text-primary/40 hover:text-primary/70 bg-primary/5 hover:bg-primary/10 px-2 py-1 rounded transition-colors">
                        {copiedId === rule.name
                          ? <><CheckCircle2 className="w-3 h-3 text-emerald-500" /> Copied</>
                          : <><Copy className="w-3 h-3" /> route:{rule.name}</>}
                      </button>
                      <button onClick={() => { setEditingId(rule.id); setCreating(false); }}
                        className="p-1.5 rounded text-muted-foreground/30 hover:text-foreground hover:bg-muted/20 transition-colors">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => deleteRule(rule.id)}
                        className="p-1.5 rounded text-muted-foreground/30 hover:text-destructive/70 hover:bg-destructive/10 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {rule.providers.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pl-7">
                      {[...rule.providers].sort((a, b) => a.priority - b.priority).map((p, i) => {
                        const rpmKey = p.providerType === "custom" ? `custom:${p.providerId ?? "unknown"}` : p.providerType === "cc" ? "cc" : p.providerType === "rc" ? "rc:pool" : "ag:pool";
                        const currentRpm = rpmStats[rpmKey] ?? 0;
                        const overLimit = p.rpmLimit > 0 && currentRpm >= p.rpmLimit;
                        return (
                          <div key={i} className={`flex items-center gap-1.5 px-2 py-1 rounded-full border text-[9px] font-mono transition-colors ${
                            overLimit ? "border-destructive/30 bg-destructive/10 text-destructive/60" : "border-border/30 bg-background/40"
                          }`}>
                            <span className="text-[8px] text-muted-foreground/40">#{i + 1}</span>
                            <span className={`font-bold ${PROVIDER_TYPE_COLORS[p.providerType]}`}>{PROVIDER_TYPE_LABELS[p.providerType]}</span>
                            <span className="text-foreground/60">{p.modelId || "—"}</span>
                            {p.rpmLimit > 0 && (
                              <span className={overLimit ? "text-destructive/60" : "text-muted-foreground/30"}>
                                {currentRpm}/{p.rpmLimit} rpm
                              </span>
                            )}
                            {p.rpmLimit === 0 && currentRpm > 0 && (
                              <span className="text-muted-foreground/30">{currentRpm} rpm</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {rule.providers.length === 0 && (
                    <p className="text-[10px] text-muted-foreground/30 font-sans pl-7">No providers configured</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Console ─────────────────────────────────────────────────────────────

const STATIC_NAV: { id: NavItem; label: string; icon: React.ReactNode }[] = [
  { id: "providers", label: "Providers",   icon: <Globe className="w-3.5 h-3.5" /> },
  { id: "api-keys",  label: "API Keys",    icon: <Key className="w-3.5 h-3.5" /> },
  { id: "cc-keys",   label: "CC Keys",     icon: <Cpu className="w-3.5 h-3.5" /> },
  { id: "rc-keys",   label: "RC Keys",     icon: <ChevronRight className="w-3.5 h-3.5" /> },
  { id: "routing",   label: "Routing",     icon: <GitBranch className="w-3.5 h-3.5" /> },
];

export default function Console() {
  const { token, logout } = useAdminAuth();
  const { theme, toggleTheme } = useTheme();
  const isAdmin = !!token;
  const [nav, setNav] = useState<NavItem>("providers");
  const [showLogin, setShowLogin] = useState(false);
  const [customProviders, setCustomProviders] = useState<CustomProvider[]>([]);

  const fetchCustomProviders = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/admin/providers", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const d = await res.json() as { providers: CustomProvider[] };
        setCustomProviders(d.providers ?? []);
      }
    } catch { /* ignore */ }
  }, [token]);

  useEffect(() => { fetchCustomProviders(); }, [fetchCustomProviders]);

  return (
    <div className="flex flex-col h-screen max-h-screen bg-background text-foreground font-mono overflow-hidden">
      {/* ── Header ── */}
      <header className="flex-none flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/60 backdrop-blur-sm z-10">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-primary" />
          <span className="font-bold text-sm tracking-tight">CommandCode</span>
          <span className="text-muted-foreground/40 text-xs hidden sm:block">/ API Console</span>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin ? (
            <button onClick={logout}
              className="flex items-center gap-1.5 text-[10px] font-sans text-emerald-500/70 hover:text-emerald-400 transition-colors px-2 py-1 rounded hover:bg-emerald-500/10">
              <Unlock className="w-3 h-3" /> Admin
            </button>
          ) : (
            <button onClick={() => setShowLogin(true)}
              className="flex items-center gap-1.5 text-[10px] font-sans text-muted-foreground/50 hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted/20">
              <Lock className="w-3 h-3" /> Unlock
            </button>
          )}
          <a href="/dashboard" target="_blank"
            className="flex items-center gap-1 text-[10px] font-sans text-muted-foreground/40 hover:text-muted-foreground px-2 py-1 rounded hover:bg-muted/20">
            <ExternalLink className="w-3 h-3" /> Dashboard
          </a>
          <button onClick={toggleTheme}
            className="p-1.5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/20 transition-colors"
            title={theme === "dark" ? "وضع الإضاءة" : "الوضع الداكن"}>
            {theme === "dark" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
        </div>
      </header>

      {/* Unlock banner */}
      {!isAdmin && <AdminLockBanner onUnlock={() => setShowLogin(true)} />}

      {/* ── Body ── */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <nav className="flex-none w-44 border-r border-border/50 bg-card/20 py-3 space-y-0.5 px-2">
          {STATIC_NAV.map(item => (
            <button key={item.id} onClick={() => setNav(item.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs transition-colors text-left
                ${nav === item.id
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted/20 hover:text-foreground"}`}>
              {item.icon}
              {item.label}
            </button>
          ))}

          {/* Dynamic nav items for each custom provider */}
          {customProviders.filter(p => p.isActive).map(p => (
            <button key={`custom-${p.slug}`} onClick={() => setNav(`custom-${p.slug}`)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs transition-colors text-left truncate
                ${nav === `custom-${p.slug}`
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted/20 hover:text-foreground"}`}>
              <Key className="w-3.5 h-3.5 flex-none" />
              <span className="truncate">{p.name} Keys</span>
              {localStorage.getItem(`provider_key_${p.slug}`) && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-none ml-auto" />
              )}
            </button>
          ))}

          <div className="pt-2 border-t border-border/30 mt-2">
            <a href="/dashboard/logs" target="_blank"
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs text-muted-foreground hover:bg-muted/20 hover:text-foreground transition-colors">
              <ExternalLink className="w-3.5 h-3.5" />
              Logs
            </a>
          </div>
        </nav>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto min-w-0">
          {nav === "providers" && <ProvidersPanel isAdmin={isAdmin} onProvidersChange={fetchCustomProviders} />}
          {nav === "api-keys"  && <ApiKeysPanel  isAdmin={isAdmin} />}
          {nav === "cc-keys"   && <CcKeysPanel   isAdmin={isAdmin} />}
          {nav === "rc-keys"   && <RcKeysPanel   isAdmin={isAdmin} />}
          {nav === "routing"   && <RoutingPanel  isAdmin={isAdmin} customProviders={customProviders} />}
          {customProviders.map(p => nav === `custom-${p.slug}` && (
            <CustomProviderKeyPanel key={p.slug} provider={p} />
          ))}
        </main>

        {/* Test Chat (always visible) */}
        <div className="flex-none w-72 lg:w-80">
          <TestChatPanel />
        </div>
      </div>

      {/* Login dialog */}
      {showLogin && (
        <LoginDialog
          onClose={() => setShowLogin(false)}
          onSuccess={() => setShowLogin(false)}
        />
      )}
    </div>
  );
}
