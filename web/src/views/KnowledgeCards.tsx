import { useEffect, useState, type ReactNode } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { KnowledgeView, SkillLibrary, SkillsView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";

const errorText = (e: unknown) => String((e as Error).message ?? e);

function ago(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** How a saved setting reaches the bot: at once, or when the profile restarts. */
const appliesWhen = (live: boolean) => (live ? "立即生效" : "该 profile 重启后生效");

/**
 * Shared skill libraries (`/skills lib`): read-only git mirrors whose skills are
 * merged into the bot's skill index behind the profile's own.
 */
export function SkillLibrariesCard({ profile }: { profile: string }) {
  const [view, setView] = useState<SkillsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState({ url: "", name: "", ref: "", path: "", include: "", exclude: "" });
  const [advanced, setAdvanced] = useState(false);
  const [interval, setIntervalDraft] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);

  const url = `/api/skills?profile=${encodeURIComponent(profile)}`;
  const show = (next: SkillsView) => {
    setView(next);
    setIntervalDraft(String(next.syncIntervalMinutes));
  };

  useEffect(() => {
    setView(null);
    setError(null);
    apiGet<SkillsView>(url)
      .then(show)
      .catch((e) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  async function act(key: string, body: Record<string, unknown>): Promise<SkillsView | null> {
    setBusy(key);
    try {
      const next = await apiPost<SkillsView>(url, body);
      show(next);
      return next;
    } catch (e) {
      toast.error(errorText(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    if (!draft.url.trim()) return;
    const next = await act("add", { action: "add", ...draft });
    if (!next) return;
    const name = next.results?.[0]?.name ?? draft.name;
    const library = next.libraries.find((l) => l.name === name);
    const loaded = library ? library.skills.length - library.shadowed.length : 0;
    toast.success(`已添加 ${name}，载入 ${loaded} 个 skill（${appliesWhen(next.live)}）`);
    if (library && library.skills.length === 0) {
      toast.message("没找到 SKILL.md：skill 要放在 <目录>/<名字>/SKILL.md，不在 skills/ 下就填「子目录」");
    }
    setDraft({ url: "", name: "", ref: "", path: "", include: "", exclude: "" });
  }

  async function sync(name?: string) {
    const next = await act(`sync:${name ?? ""}`, { action: "sync", ...(name ? { name } : {}) });
    const failed = next?.results?.filter((r) => !r.ok) ?? [];
    if (!next) return;
    if (failed.length > 0) toast.error(failed.map((r) => `${r.name}：${r.error ?? "同步失败"}`).join("\n"));
    else toast.success(next.results?.some((r) => r.changed) ? "已同步到最新提交" : "已是最新");
  }

  async function remove(name: string) {
    setRemoving(null);
    if (await act(`remove:${name}`, { action: "remove", name })) toast.success(`已移除 ${name}，本地镜像一起删掉了`);
  }

  async function saveInterval() {
    const next = await act("interval", { action: "interval", minutes: Number(interval) });
    if (next) toast.success(`已保存（${appliesWhen(next.live)}）`);
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Skill 库</CardTitle>
        {view && view.libraries.length > 0 && (
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => sync()}>
            {busy === "sync:" ? "同步中…" : "全部同步"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          把 git 仓库里的 skill 作为只读镜像加载，几个 bot 共用同一批 skill。要改 skill 去改仓库本身，这里只拉取。
        </p>
        {error && <p className="text-sm text-destructive">加载失败：{error}</p>}
        {!error && !view && <p className="text-sm text-muted-foreground">加载中…</p>}
        {view && (
          <>
            {!view.live && (
              <p className="text-xs text-primary">
                该 profile 不在本控制台进程里运行：新增 / 移除库、改同步间隔要等它重启后才完全生效；「同步」直接更新磁盘上的镜像。
              </p>
            )}

            <div className="divide-y rounded-xl border">
              {view.libraries.length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">（还没有配置 skill 库）</p>
              )}
              {view.libraries.map((library) => (
                <LibraryRow
                  key={library.name}
                  library={library}
                  busy={busy}
                  onSync={() => sync(library.name)}
                  onRemove={() => setRemoving(library.name)}
                />
              ))}
            </div>

            <div className="space-y-2">
              <Label>添加库</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="git 地址，如 git@github.com:org/skills.git"
                  value={draft.url}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
                />
                <Input
                  className="w-40"
                  placeholder="名字（可选）"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <Button variant="outline" disabled={busy !== null || !draft.url.trim()} onClick={add}>
                  {busy === "add" ? "拉取中…" : "添加"}
                </Button>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setAdvanced(!advanced)}>
                {advanced ? "收起选项" : "更多选项（分支、子目录、筛选）"}
              </Button>
              {advanced && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="分支 / 标签 / 提交" hint="不填跟随远端默认分支">
                    <Input value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} />
                  </Field>
                  <Field label="子目录" hint="不填：有 skills/ 用它，否则仓库根目录">
                    <Input value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} />
                  </Field>
                  <Field label="只载入" hint="skill 名，逗号分隔；不填全部载入">
                    <Input value={draft.include} onChange={(e) => setDraft({ ...draft, include: e.target.value })} />
                  </Field>
                  <Field label="排除" hint="skill 名，逗号分隔">
                    <Input value={draft.exclude} onChange={(e) => setDraft({ ...draft, exclude: e.target.value })} />
                  </Field>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                先拉取成功才会保存。私有仓库用本机已配好的 SSH key 访问，不要把 token 写进地址。同名 skill：profile 自己的优先，其次是先添加的库。
              </p>
            </div>

            <Separator />

            <IntervalField
              label="自动同步间隔（分钟）"
              hint="启动时同步一次，之后按这个间隔拉取；0 = 只在启动和手动同步时拉取。默认 60。"
              value={interval}
              onChange={setIntervalDraft}
              saving={busy === "interval"}
              disabled={busy !== null || interval === String(view.syncIntervalMinutes)}
              onSave={saveInterval}
            />
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={removing !== null}
        title={`移除 skill 库 ${removing ?? ""}？`}
        description="从配置里删掉这个库，本地镜像一起删除；它带来的 skill 不再出现在 bot 的索引里。仓库本身不受影响。"
        confirm="移除"
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove(removing)}
      />
    </Card>
  );
}

function LibraryRow({ library, busy, onSync, onRemove }: {
  library: SkillLibrary;
  busy: string | null;
  onSync: () => void;
  onRemove: () => void;
}) {
  const shadowed = new Set(library.shadowed);
  return (
    <div className="space-y-1.5 px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{library.name}</span>
          {library.present ? (
            <Badge variant="secondary" title={library.commitAt ? new Date(library.commitAt).toLocaleString() : undefined}>
              {library.commit ?? "?"}{library.commitAt ? ` · ${ago(library.commitAt)}提交` : ""}
            </Badge>
          ) : (
            <Badge variant="destructive">未拉取</Badge>
          )}
          {library.ref && <Badge variant="outline">ref {library.ref}</Badge>}
          {library.path && <Badge variant="outline">目录 {library.path}</Badge>}
          {library.include && <Badge variant="outline">只载入 {library.include.join(", ")}</Badge>}
          {library.exclude && <Badge variant="outline">排除 {library.exclude.join(", ")}</Badge>}
        </div>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={onSync}>
          {busy === `sync:${library.name}` ? "同步中…" : "同步"}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={onRemove}>移除</Button>
      </div>
      <div className="truncate font-mono text-xs text-muted-foreground">{library.url}</div>
      {library.skills.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {library.skills.map((skill) => (
            <Badge
              key={skill.name}
              variant="outline"
              className={shadowed.has(skill.name) ? "line-through opacity-60" : undefined}
              title={shadowed.has(skill.name) ? "同名 skill 已存在，未载入" : skill.description}
            >
              {skill.name}
            </Badge>
          ))}
        </div>
      ) : (
        library.present && <p className="text-xs text-muted-foreground">没找到 SKILL.md</p>
      )}
      {library.shadowed.length > 0 && (
        <p className="text-xs text-muted-foreground">同名已存在、未载入：{library.shadowed.join("、")}</p>
      )}
      {library.lastError ? (
        <p className="text-xs text-destructive">
          上次同步失败{library.lastSyncAt ? `（${ago(library.lastSyncAt)}）` : ""}：{library.lastError}
        </p>
      ) : (
        library.lastSyncAt && <p className="text-xs text-muted-foreground">上次同步 {ago(library.lastSyncAt)}</p>
      )}
    </div>
  );
}

/**
 * The profile's knowledge directory (memories + own skills) and the git remote
 * it syncs with (`/knowledge`).
 */
export function KnowledgeCard({ profile }: { profile: string }) {
  const [view, setView] = useState<KnowledgeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [remote, setRemote] = useState("");
  const [interval, setIntervalDraft] = useState("");
  const [confirm, setConfirm] = useState<"bind" | "unbind" | null>(null);

  const url = `/api/knowledge?profile=${encodeURIComponent(profile)}`;
  const show = (next: KnowledgeView) => {
    setView(next);
    setIntervalDraft(String(next.syncIntervalMinutes));
  };

  useEffect(() => {
    setView(null);
    setError(null);
    apiGet<KnowledgeView>(url)
      .then(show)
      .catch((e) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  async function act(key: string, body: Record<string, unknown>): Promise<KnowledgeView | null> {
    setBusy(key);
    try {
      const next = await apiPost<KnowledgeView>(url, body);
      show(next);
      return next;
    } catch (e) {
      toast.error(errorText(e));
      // A failed sync is still worth showing (status, last result).
      apiGet<KnowledgeView>(url).then(show).catch(() => {});
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function bind() {
    setConfirm(null);
    const next = await act("bind", { action: "bind", url: remote.trim() });
    if (!next) return;
    toast.success(next.note ?? "已绑定，远端已有的记忆和 skill 都拉下来了");
    setRemote("");
  }

  async function unbind() {
    setConfirm(null);
    if (await act("unbind", { action: "unbind" })) toast.success("已解除远端绑定，本地内容保留");
  }

  async function sync() {
    const next = await act("sync", { action: "sync" });
    const o = next?.outcome;
    if (!o) return;
    const parts = [
      o.committed > 0 ? `提交了 ${o.committed} 个文件` : "本地没有新改动",
      o.pulled ? "已拉取远端" : "",
      o.pushed ? "已推送" : "",
    ].filter(Boolean);
    toast.success(`${parts.join("，")}。${o.note ?? ""}`);
  }

  async function saveInterval() {
    const next = await act("interval", { action: "interval", minutes: Number(interval) });
    if (next) toast.success(`已保存（${appliesWhen(next.live)}）`);
  }

  const last = view?.autoSync?.last;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>知识库</CardTitle>
        {view?.remote && (
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={sync}>
            {busy === "sync" ? "同步中…" : "立即同步"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          跨会话记忆和本 profile 自己的 skill。绑定一个 git 仓库后，几台机器、几个 bot 可以共用同一份。
        </p>
        {error && <p className="text-sm text-destructive">加载失败：{error}</p>}
        {!error && !view && <p className="text-sm text-muted-foreground">加载中…</p>}
        {view && (
          <>
            {!view.live && (
              <p className="text-xs text-primary">
                该 profile 不在本控制台进程里运行：绑定、同步直接作用于知识目录，立即生效；同步间隔要等它重启后才生效。
              </p>
            )}

            <div className="space-y-1.5 rounded-xl border px-3 py-2">
              <Row label="目录"><span className="break-all font-mono text-xs">{view.dir}</span></Row>
              <Row label="远端">
                {view.remote ? (
                  <span className="break-all font-mono text-xs">{view.remote}</span>
                ) : (
                  <Badge variant="outline">未绑定</Badge>
                )}
              </Row>
              {view.repo && (
                <Row label="状态">
                  <span className="flex flex-wrap items-center gap-1.5 text-xs">
                    {view.branch && <Badge variant="secondary">{view.branch}</Badge>}
                    {view.ahead !== undefined && view.behind !== undefined && (
                      <span className="text-muted-foreground">↑{view.ahead} ↓{view.behind}</span>
                    )}
                    {view.dirty && <span className="text-muted-foreground">有未提交的本地改动</span>}
                  </span>
                </Row>
              )}
              <Row label="内容">
                <span className="text-xs">全局记忆 {view.profileMemories} 条 · 自有 skill {view.ownSkills} 个</span>
              </Row>
              {view.autoSync && (
                <Row label="自动同步">
                  <span className="flex flex-wrap items-center gap-1.5 text-xs">
                    {view.autoSync.syncing && <Badge variant="secondary">同步中</Badge>}
                    {last ? (
                      <span className={last.ok ? "text-muted-foreground" : "text-destructive"}>
                        上次{last.trigger === "auto" ? "自动" : "手动"}同步 {ago(last.at)}：{last.ok ? "成功" : `失败（${last.error ?? "未知错误"}）`}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">本次启动后还没同步过</span>
                    )}
                    {view.autoSync.failures > 1 && (
                      <Badge variant="destructive">连续失败 {view.autoSync.failures} 次</Badge>
                    )}
                  </span>
                </Row>
              )}
            </div>

            <div className="space-y-2">
              <Label>{view.remote ? "改绑远端" : "绑定远端"}</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="git 仓库地址，如 git@github.com:org/bot-knowledge.git"
                  value={remote}
                  onChange={(e) => setRemote(e.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={busy !== null || !remote.trim()}
                  onClick={() => (view.remote ? setConfirm("bind") : bind())}
                >
                  {busy === "bind" ? "绑定中…" : view.remote ? "改绑" : "绑定"}
                </Button>
                {view.remote && (
                  <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirm("unbind")}>
                    解除绑定
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                绑定是合并不是覆盖：本地已有的记忆保留，远端已有的内容拉下来。凭据用本机已有的 git 配置（SSH key）。
              </p>
            </div>

            <Separator />

            <IntervalField
              label="自动同步间隔（分钟）"
              hint="绑定远端后按这个间隔提交本地改动、拉取、推送；0 = 关闭自动同步，只手动同步。默认 30。"
              value={interval}
              onChange={setIntervalDraft}
              saving={busy === "interval"}
              disabled={busy !== null || interval === String(view.syncIntervalMinutes)}
              onSave={saveInterval}
            />
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirm === "bind"}
        title="改绑知识库远端？"
        description="知识目录会改为跟新仓库同步，并把新仓库已有的内容合并进来；原来的仓库不受影响，但之后不再同步。"
        confirm="改绑"
        onCancel={() => setConfirm(null)}
        onConfirm={bind}
      />
      <ConfirmDialog
        open={confirm === "unbind"}
        title="解除知识库远端绑定？"
        description="之后不再自动同步，本地记忆和 skill 保留，远端仓库不受影响。随时可以重新绑定。"
        confirm="解除绑定"
        onCancel={() => setConfirm(null)}
        onConfirm={unbind}
      />
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function IntervalField({ label, hint, value, onChange, saving, disabled, onSave }: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  saving: boolean;
  disabled: boolean;
  onSave: () => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <Input className="w-32" type="number" min={0} max={10080} value={value} onChange={(e) => onChange(e.target.value)} />
        <Button variant="outline" disabled={disabled} onClick={onSave}>{saving ? "保存中…" : "保存"}</Button>
      </div>
    </Field>
  );
}

function ConfirmDialog({ open, title, description, confirm, onCancel, onConfirm }: {
  open: boolean;
  title: string;
  description: string;
  confirm: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button variant="destructive" onClick={onConfirm}>{confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
