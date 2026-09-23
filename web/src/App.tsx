import { useMemo, useState } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Button, Input } from "@cloudflare/kumo";
import {
  ArrowsLeftRight,
  ArrowRight,
  Key,
  PlugsConnected,
  PaperPlaneTilt,
  GitBranch,
  ListChecks,
  ClockCounterClockwise,
  SquaresFour,
  Stack,
  SignOut,
  Moon,
  Sun,
} from "@phosphor-icons/react";
import { createApi } from "./api";
import type { Kind, Tab, Resource, Meta } from "./types";
import { labels } from "./types";
import { Resources } from "./Resources";
import { Records } from "./Records";
import { TemplateLibrary } from "./TemplateLibrary";
import { Overview } from "./Overview";
import { RelayMark } from "./RelayMark";
import type { RecordFilters, Navigate } from "./types";

const icons = {
  overview: SquaresFour,
  keys: Key,
  sources: PlugsConnected,
  destinations: PaperPlaneTilt,
  routes: GitBranch,
  templates: Stack,
  events: ListChecks,
  deliveries: ArrowsLeftRight,
  audit: ClockCounterClockwise,
};
const kinds: Kind[] = ["keys", "sources", "destinations", "routes"];
export function App() {
  const [token, setToken] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dark, setDark] = useState(false);
  const queryClient = useQueryClient();
  const api = useMemo(() => createApi(token), [token]);
  async function login(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await createApi(input)<Meta>("/meta");
      setToken(input);
      setInput("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function logout() {
    setToken("");
    queryClient.clear();
  }
  const themeButton = (
    <Button
      variant="ghost"
      aria-label={dark ? "切换浅色模式" : "切换深色模式"}
      shape="square"
      icon={dark ? <Sun size={18} /> : <Moon size={18} />}
      onClick={() => {
        setDark(!dark);
        document.documentElement.dataset.mode = dark ? "light" : "dark";
      }}
    />
  );
  if (!token)
    return (
      <main className="login-shell">
        <div className="login-top">{themeButton}</div>
        <section className="login-card">
          <div className="brand-mark">
            <RelayMark size={52} />
          </div>
          <h1 className="mb-6">Webhook Relay</h1>
          <form onSubmit={login} className="grid gap-5">
            <Input
              label="管理令牌"
              type="password"
              autoComplete="current-password"
              required
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            {error && (
              <p role="alert" className="error-box">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" loading={busy}>
              进入控制台 <ArrowRight size={16} />
            </Button>
          </form>
        </section>
      </main>
    );
  return <Console api={api} logout={logout} themeButton={themeButton} />;
}
export function Console({
  api,
  logout,
  themeButton,
  initialTab = "overview",
}: {
  api: ReturnType<typeof createApi>;
  logout: () => void;
  themeButton: React.ReactNode;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [filters, setFilters] = useState<RecordFilters>({});
  const navigate: Navigate = (next, filter = {}) => {
    setTab(next);
    setFilters(filter);
  };
  const resources = useQuery({
    queryKey: ["resources"],
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(
          kinds.map(async (k) => [k, await api<Resource[]>(`/resources/${k}`)]),
        ),
      ) as Record<Kind, Resource[]>,
  });
  const meta = useQuery({
    queryKey: ["meta"],
    queryFn: () => api<Meta>("/meta"),
  });
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
        >
          <RelayMark size={33} />
          <span>Relay</span>
        </a>
        <nav aria-label="主导航">
          {(Object.keys(icons) as Tab[]).map((key) => {
            const Icon = icons[key];
            return (
              <button
                key={key}
                className={`nav-item ${tab === key ? "active" : ""}`}
                aria-current={tab === key ? "page" : undefined}
                onClick={() => navigate(key)}
              >
                <Icon size={18} />
                {labels[key]}
              </button>
            );
          })}
        </nav>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <h1>{labels[tab]}</h1>
          <div className="flex items-center gap-2">
            {themeButton}
            <Button
              variant="ghost"
              icon={<SignOut size={16} />}
              onClick={logout}
            >
              退出
            </Button>
          </div>
        </header>
        <main className="content">
          {resources.isPending || meta.isPending ? (
            <p role="status">正在加载工作空间…</p>
          ) : resources.error || meta.error ? (
            <div role="alert" className="error-box">
              {(resources.error || meta.error)?.message}
              <Button
                onClick={() => {
                  void resources.refetch();
                  void meta.refetch();
                }}
              >
                重试
              </Button>
            </div>
          ) : (
            <>
              {tab === "overview" ? (
                <Overview
                  api={api}
                  onNavigate={navigate}
                  meta={meta.data!}
                  sources={resources.data!.sources}
                />
              ) : tab === "templates" ? (
                <TemplateLibrary
                  meta={meta.data!}
                  api={api}
                  onNavigate={navigate}
                />
              ) : kinds.includes(tab as Kind) ? (
                <Resources
                  key={tab}
                  kind={tab as Kind}
                  data={resources.data!}
                  meta={meta.data!}
                  api={api}
                />
              ) : (
                <Records
                  key={`${tab}:${JSON.stringify(filters)}`}
                  initialFilters={filters}
                  meta={meta.data!}
                  onNavigate={navigate}
                  kind={tab as "events" | "deliveries" | "audit"}
                  api={api}
                  data={resources.data!}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
